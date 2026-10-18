#!/usr/bin/env python3
"""Administrative CLI; authorization comes from the connecting Linux uid."""
import argparse
import http.client
import json
from urllib.parse import quote, urlencode


def request(port: int, method: str, path: str, data=None, proof=None):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=180)
    headers = {"Content-Type": "application/json"}
    if proof:
        headers["X-Dori-Owner-Message"] = proof
    try:
        connection.request(method, path, json.dumps(data).encode() if data is not None else b"", headers)
        response = connection.getresponse()
        body = response.read()
        if not 200 <= response.status < 300:
            raise SystemExit(f"gate returned HTTP {response.status}: {body.decode()}")
        return json.loads(body)
    finally:
        connection.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=3129)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("auth-url", "status", "tokeninfo"):
        sub.add_parser(name)
    finish = sub.add_parser("auth-finish")
    finish.add_argument("redirect")
    changes = sub.add_parser("changes")
    changes.add_argument("--since", default="24h")
    restore = sub.add_parser("restore")
    restore.add_argument("id")
    restore.add_argument("--owner-message")
    args = parser.parse_args()
    if args.command == "changes":
        result = request(args.port, "GET", "/_gate/changes?" + urlencode({"since": args.since}))
    elif args.command == "restore":
        result = request(args.port, "POST", "/_gate/restore/" + quote(args.id, safe=""),
                         proof=args.owner_message)
    else:
        result = request(args.port, "POST" if args.command.startswith("auth-") else "GET",
                         "/_admin/" + args.command,
                         {"redirect": args.redirect} if args.command == "auth-finish" else None)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
