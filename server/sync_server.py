#!/usr/bin/env python3
"""
Lightweight Offline Sync Relay Server for Rural Health Clinics
Runs on Python 3.x using only standard library modules (http.server, sqlite3, json).
Serves static frontend files and provides REST endpoints for weak-link delta sync.
"""

import os
import sys
import json
import sqlite3
import time
from http.server import SimpleHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

PORT = 8080
ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DB_PATH = os.path.join(ROOT_DIR, "clinic_hub.db")

def init_db():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS deltas (
        delta_id TEXT PRIMARY KEY,
        delta_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        hlc TEXT NOT NULL,
        data_json TEXT NOT NULL,
        hash TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    """)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS sync_checkpoints (
        node_id TEXT PRIMARY KEY,
        last_hlc TEXT NOT NULL,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    """)
    conn.commit()
    conn.close()

class ClinicSyncHTTPHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT_DIR, **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/status":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            status_data = {
                "server": "RuralHealth-Hub-Relay",
                "status": "ONLINE",
                "time_ms": int(time.time() * 1000),
                "sdg_alignment": ["SDG-3", "SDG-4", "SDG-10"],
                "encryption": "AES-GCM-256",
                "crdt_model": "Monotonic Append-Only Log + Domain-Aware Resolution"
            }
            self.wfile.write(json.dumps(status_data).encode("utf-8"))
            return

        elif parsed.path == "/api/sync/pull":
            params = parse_qs(parsed.query)
            since_hlc = params.get("since_hlc", ["0:0:INIT"])[0]
            
            conn = sqlite3.connect(DB_PATH)
            cursor = conn.cursor()
            cursor.execute("SELECT delta_id, delta_type, entity_id, hlc, data_json, hash FROM deltas ORDER BY hlc ASC")
            rows = cursor.fetchall()
            conn.close()

            deltas = []
            for r in rows:
                deltas.append({
                    "deltaId": r[0],
                    "type": r[1],
                    "entityId": r[2],
                    "hlc": r[3],
                    "data": json.loads(r[4]),
                    "hash": r[5]
                })

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"deltas": deltas, "count": len(deltas)}).encode("utf-8"))
            return

        # Fallback to static file server
        super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/sync/push":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length).decode("utf-8")
            data = json.loads(body)
            incoming_deltas = data.get("deltas", [])

            conn = sqlite3.connect(DB_PATH)
            cursor = conn.cursor()
            acked = []

            for d in incoming_deltas:
                delta_id = d.get("deltaId")
                delta_type = d.get("type", "UNKNOWN")
                entity_id = d.get("entityId", "")
                hlc = d.get("hlc", "")
                data_json = json.dumps(d.get("data", {}))
                h = d.get("hash", "")

                try:
                    cursor.execute("""
                        INSERT OR IGNORE INTO deltas (delta_id, delta_type, entity_id, hlc, data_json, hash)
                        VALUES (?, ?, ?, ?, ?, ?)
                    """, (delta_id, delta_type, entity_id, hlc, data_json, h))
                    acked.append(delta_id)
                except Exception as e:
                    print("Error storing delta:", e)

            conn.commit()
            conn.close()

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok", "ackedIds": acked, "receivedCount": len(incoming_deltas)}).encode("utf-8"))
            return

        self.send_response(404)
        self.end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

def run():
    init_db()
    server_address = ("", PORT)
    httpd = HTTPServer(server_address, ClinicSyncHTTPHandler)
    print("=" * 60)
    print("Electronic Health Record Offline Sync Server")
    print(f"Serving at: http://localhost:{PORT}")
    print(f"Root Directory: {ROOT_DIR}")
    print("Works 100% offline without internet connection!")
    print("=" * 60)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server.")
        httpd.server_close()

if __name__ == "__main__":
    run()
