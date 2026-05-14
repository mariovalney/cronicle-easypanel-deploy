import sys
import json
import time
import os


class Observer:
    def __init__(self):
        self.job = self._read_job()

    def _read_job(self) -> dict:
        try:
            if not sys.stdin.isatty():
                line = sys.stdin.readline()
                return json.loads(line) if line.strip() else {}
        except Exception:
            pass
        return {}

    def _emit(self, data: dict) -> None:
        sys.stdout.write(json.dumps(data) + "\n")
        sys.stdout.flush()

    def progress(self, value: float) -> None:
        self._emit({"progress": round(max(0.0, min(1.0, value)), 2)})

    def success(self, description: str = None, perf: dict = None, label: str = None) -> None:
        data: dict = {"complete": 1, "code": 0}
        if description:
            data["description"] = description
        if perf:
            data["perf"] = perf
        if label:
            data["label"] = label
        self._emit(data)

    def failure(self, description: str, code: int = 1, perf: dict = None) -> None:
        data: dict = {"complete": 1, "code": code, "description": description}
        if perf:
            data["perf"] = perf
        self._emit(data)


DURATION = 60
STEPS = 6


def main():
    obs = Observer()

    print(f"Starting hello-world ({DURATION}s)")

    for i in range(STEPS):
        time.sleep(DURATION / STEPS)
        obs.progress((i + 1) / STEPS)

    if os.getenv("FORCE_ERROR", "").lower() == "true":
        obs.failure("Forced error via FORCE_ERROR=true")
        return

    obs.success(label="hello-world completed")


if __name__ == "__main__":
    main()
