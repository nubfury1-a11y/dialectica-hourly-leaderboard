#!/usr/bin/env python3
"""Collect Dialectica's public leaderboard and write a privacy-filtered Pages dataset."""
from __future__ import annotations

import json
import math
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

DISPLAY_LABELS = ["Nubfury", "gaming", "nubfury1", "pintu", "trading"]
API_URL = "https://dialectica.xyz/api/node/leaderboard/ranking"
INTERVAL_SECONDS = 900
HISTORY_PATH = Path(__file__).resolve().parents[1] / "docs" / "data" / "leaderboard.json"


class PublicSourceError(RuntimeError):
    """A safe, non-identifying error reading the public feed."""


def now_utc() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def iso(value: datetime) -> str:
    return value.isoformat()


def parse_time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def private_labels() -> list[str]:
    """Read source matchers only from the encrypted workflow secret."""
    try:
        values = json.loads(os.environ["PRIVATE_AGENT_LABELS"])
    except (KeyError, json.JSONDecodeError, TypeError):
        raise RuntimeError("Required private collector configuration is unavailable.") from None
    if (
        not isinstance(values, list)
        or len(values) != len(DISPLAY_LABELS)
        or any(not isinstance(value, str) or not value.strip() for value in values)
    ):
        raise RuntimeError("Private collector configuration must contain five non-empty labels.")
    cleaned = [value.strip() for value in values]
    if len({value.casefold() for value in cleaned}) != len(cleaned):
        raise RuntimeError("Private collector labels must be unique.")
    return cleaned


def _number(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise PublicSourceError()
    number = float(value)
    if not math.isfinite(number):
        raise PublicSourceError()
    return number


def fetch_matches(labels: list[str]) -> tuple[dict[str, dict[str, Any]], int, int]:
    query = urlencode({"by": "agent", "measure": "coins", "limit": 100})
    request = Request(
        f"{API_URL}?{query}",
        headers={
            "Accept": "application/json",
            "User-Agent": "DialecticaPublicLeaderboard/1.0",
            "Referer": "https://dialectica.xyz/leaderboard?by=agent",
        },
    )
    try:
        with urlopen(request, timeout=25) as response:
            payload = json.loads(response.read())
    except (URLError, TimeoutError, OSError, ValueError):
        raise PublicSourceError() from None

    if not isinstance(payload, dict) or payload.get("success") is not True:
        raise PublicSourceError()
    data = payload.get("data")
    if not isinstance(data, dict) or not isinstance(data.get("rows"), list):
        raise PublicSourceError()

    label_to_display = {label.casefold(): display for label, display in zip(labels, DISPLAY_LABELS)}
    matches: dict[str, dict[str, Any]] = {}
    rows = data["rows"]
    for row in rows:
        if not isinstance(row, dict) or row.get("kind") != "agent":
            continue
        source_label = row.get("label")
        if not isinstance(source_label, str):
            continue
        display = label_to_display.get(source_label.strip().casefold())
        if display is None or display in matches:
            continue
        try:
            total = _number(row.get("value"), "total")
            verified = int(row.get("verifiedAnswers"))
            rank = int(row.get("rank"))
        except (TypeError, ValueError, OverflowError):
            raise PublicSourceError() from None
        if verified < 0 or rank < 1:
            raise PublicSourceError()
        # Store only user-approved display labels and public measurements.
        matches[display] = {
            "total_trued": total,
            "verified_answers": verified,
            "source_rank": rank,
        }

    total_rows = data.get("total", len(rows))
    try:
        total_rows = int(total_rows)
    except (TypeError, ValueError, OverflowError):
        total_rows = len(rows)
    return matches, total_rows, len(rows)


def _safe_history(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    clean: list[dict[str, Any]] = []
    for record in raw:
        if not isinstance(record, dict) or not isinstance(record.get("timestamp"), str):
            continue
        try:
            timestamp = iso(parse_time(record["timestamp"]))
        except (ValueError, TypeError, OverflowError):
            continue
        raw_agents = record.get("agents")
        if not isinstance(raw_agents, dict):
            continue
        agents: dict[str, dict[str, Any]] = {}
        for display in DISPLAY_LABELS:
            values = raw_agents.get(display)
            if not isinstance(values, dict):
                continue
            try:
                total = _number(values.get("total_trued"), "total")
                verified = int(values.get("verified_answers"))
                rank = int(values.get("source_rank"))
            except (TypeError, ValueError, OverflowError, PublicSourceError):
                continue
            if verified < 0 or rank < 1:
                continue
            agents[display] = {
                "total_trued": total,
                "verified_answers": verified,
                "source_rank": rank,
            }
        clean.append({"timestamp": timestamp, "agents": agents})
    clean.sort(key=lambda item: parse_time(item["timestamp"]))
    return clean


def read_existing() -> dict[str, Any]:
    if not HISTORY_PATH.exists():
        return {"history": []}
    try:
        payload = json.loads(HISTORY_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        raise RuntimeError("Existing public history could not be read; no file was overwritten.") from None
    if not isinstance(payload, dict):
        raise RuntimeError("Existing public history has an invalid format; no file was overwritten.")
    return payload


def delta_from_baseline(records: list[dict[str, Any]], hours: int, value_key: str) -> float | int | None:
    if len(records) < 2:
        return None
    latest = records[-1]
    cutoff = parse_time(latest["timestamp"]) - timedelta(hours=hours)
    baseline = None
    for record in records[:-1]:
        if parse_time(record["timestamp"]) <= cutoff:
            baseline = record
        else:
            break
    if baseline is None:
        return None
    return latest[value_key] - baseline[value_key]


def make_dashboard(
    history: list[dict[str, Any]],
    *,
    attempted_at: datetime,
    last_error: str | None,
    unmatched: list[str],
    source_total: int | None,
    source_returned: int | None,
) -> dict[str, Any]:
    grouped: dict[str, list[dict[str, Any]]] = {label: [] for label in DISPLAY_LABELS}
    for snapshot in history:
        for label in DISPLAY_LABELS:
            values = snapshot["agents"].get(label)
            if values:
                grouped[label].append({"timestamp": snapshot["timestamp"], **values})

    agents: list[dict[str, Any]] = []
    for label in DISPLAY_LABELS:
        records = grouped[label]
        latest = records[-1] if records else None
        earned_1h = delta_from_baseline(records, 1, "total_trued")
        earned_24h = delta_from_baseline(records, 24, "total_trued")
        verified_1h = delta_from_baseline(records, 1, "verified_answers")
        agents.append({
            "name": label,
            "found": latest is not None,
            "source_rank": latest.get("source_rank") if latest else None,
            "total_trued": latest.get("total_trued") if latest else None,
            "verified_answers": latest.get("verified_answers") if latest else None,
            "earned_1h": earned_1h,
            "earned_24h": earned_24h,
            "verified_1h": verified_1h,
            "last_snapshot_at": latest.get("timestamp") if latest else None,
        })

    available_1h = [agent["earned_1h"] for agent in agents if agent["earned_1h"] is not None]
    available_24h = [agent["earned_24h"] for agent in agents if agent["earned_24h"] is not None]
    available_1h_count = len(available_1h)
    available_24h_count = len(available_24h)
    top_candidates = [agent for agent in agents if agent["earned_1h"] is not None]
    top = max(top_candidates, key=lambda agent: agent["earned_1h"]) if top_candidates else None
    latest_times = [item["last_snapshot_at"] for item in agents if item["last_snapshot_at"]]
    last_snapshot_at = max(latest_times, key=parse_time) if latest_times else None

    chart_cutoff = attempted_at - timedelta(hours=24)
    point_times: set[str] = set()
    points: dict[str, dict[str, float | None]] = {label: {} for label in DISPLAY_LABELS}
    for label in DISPLAY_LABELS:
        records = grouped[label]
        for index, current in enumerate(records):
            if parse_time(current["timestamp"]) < chart_cutoff:
                continue
            change = None
            if index > 0:
                change = current["total_trued"] - records[index - 1]["total_trued"]
            point_times.add(current["timestamp"])
            points[label][current["timestamp"]] = change
    chart_labels = sorted(point_times, key=parse_time)
    chart_sets = [
        {"label": label, "data": [points[label].get(timestamp) for timestamp in chart_labels]}
        for label in DISPLAY_LABELS
    ]

    return {
        "generated_at": iso(attempted_at),
        "last_attempt_at": iso(attempted_at),
        "last_snapshot_at": last_snapshot_at,
        "next_snapshot_at": iso(attempted_at + timedelta(seconds=INTERVAL_SECONDS)),
        "refresh_interval_seconds": INTERVAL_SECONDS,
        "last_error": last_error,
        "unmatched": unmatched,
        "source_total": source_total,
        "source_returned": source_returned,
        "configured_agent_count": len(DISPLAY_LABELS),
        "matched_count": sum(1 for agent in agents if agent["found"]),
        "combined_1h": sum(available_1h) if available_1h else None,
        "combined_24h": sum(available_24h) if available_24h else None,
        "baseline_1h_count": available_1h_count,
        "baseline_24h_count": available_24h_count,
        "top_agent": {"name": top["name"], "earned_1h": top["earned_1h"]} if top else None,
        "agents": agents,
        "chart": {"labels": chart_labels, "datasets": chart_sets},
        "history_count": len(history),
        "history": history,
    }


def write_atomic(payload: dict[str, Any]) -> None:
    HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix="leaderboard-", suffix=".json", dir=HISTORY_PATH.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(payload, output, ensure_ascii=False, separators=(",", ":"))
            output.write("\n")
        os.replace(temp_name, HISTORY_PATH)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def main() -> int:
    labels = private_labels()
    old = read_existing()
    history = _safe_history(old.get("history", []))
    attempted_at = now_utc()
    last_error = None
    source_total = old.get("source_total") if isinstance(old.get("source_total"), int) else None
    source_returned = old.get("source_returned") if isinstance(old.get("source_returned"), int) else None
    unmatched = old.get("unmatched") if isinstance(old.get("unmatched"), list) else []
    unmatched = [label for label in unmatched if label in DISPLAY_LABELS]

    try:
        matches, source_total, source_returned = fetch_matches(labels)
        unmatched = [label for label in DISPLAY_LABELS if label not in matches]
        snapshot = {"timestamp": iso(attempted_at), "agents": matches}
        if history and history[-1]["timestamp"] == snapshot["timestamp"]:
            history[-1] = snapshot
        else:
            history.append(snapshot)
    except PublicSourceError:
        last_error = "The latest check could not read Dialectica's public leaderboard."

    payload = make_dashboard(
        history,
        attempted_at=attempted_at,
        last_error=last_error,
        unmatched=unmatched,
        source_total=source_total,
        source_returned=source_returned,
    )
    write_atomic(payload)
    print(f"Saved public dashboard data; {payload['history_count']} snapshots retained.")
    if last_error:
        print("The source check failed; existing history was preserved.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
