# 🏥 Electronic Health Record — Offline-First Spreadsheet Ledger

> **Offline-First Medical Ledger**: Designed for clinics, community health workers, and mobile health units with CRDTs, Hybrid Logical Clocks, Offline Voice Notes, and Resumable Delta Sync.

---

## 📌 Executive Summary

Designed for **Clinics, Community Health Workers, and Village Centers** operating offline or over intermittent connections.

**Key Architecture Guarantees**:
- **Data-loss rate**: **0.00%** (Strictly zero data loss via monotonic append-only log CRDT)
- **Causality tracking**: Hybrid Logical Clocks $HLC = (l, c, node\_id)$
- **Encryption at rest**: Web Crypto API `AES-GCM-256` with PBKDF2 key derivation
- **Conflict-resolution correctness**: Domain-aware detection prevents dangerous medical overwrites
- **Interrupted-sync recovery**: Resumable checkpointing protocol resumes precisely where disconnected

---

## 🎨 UI & Workflow Architecture (Faithful to Hand-Drawn Sketches)

The application features a vintage **spreadsheet-like medical ledger aesthetic** (clean gridlines, formula bar, status ticker, green banner, high contrast) built to run effortlessly on low-power village tablets and clinic laptops.

### 1. Landing Choice Page (Notebook Sketch 1)
- Prominent header: **ELECTRONIC HEALTH RECORD**
- Two clear, primary action cards:
  - `[ + NEW PATIENT ]` — Generates a new Unique ID, opens registration form, creates dynamic QR card.
  - `OR`
  - `[ 📷 EXISTING PATIENT (SCAN QR) ]` — Opens live camera QR scanner or image file reader.
- Quick lookup box: Search by Patient ID or Name.

### 2. Form Page (Notebook Sketch 2)
- Header with synchronized **Date and Time** (live timestamp + HLC clock).
- Grid layout matching the sketch:
  - `[ Patient Name | Gender ]` and `[ Age ]`
  - `[ Disease Type ]` dropdown menu: *Chronic, Viral, Emergency, Bacterial, Vector-Borne, Maternal/Pediatric*.
  - `[ Prescribed Medicine ]` formulary dropdown: *Paracetamol, Ibuprofen, Amoxicillin, ORS, Metformin, Cetirizine, Azithromycin, Artemether+Lumefantrine*, plus quick chips.
  - `[ Prescription ]` & `[ Description ]` inputs for doctor's clinical findings and dosage schedule.
  - `[ QR Code ]` box: Generates and displays the patient's unique QR code containing the Unique ID (with 1-click printable health slip).
  - `[ Voice Note ]`: Record clinical notes directly from microphone with timer, or attach synthesized demo chime. Works **100% offline**.
- `[ 💾 Save Patient Record to Local Database ]`: Persists to local IndexedDB with AES-GCM-256 encryption at rest.

### 3. Existing Patient Follow-up Workflow
- Doctor scans patient's QR card via camera or enters Unique ID.
- Displays patient master profile and **complete past visit logs**.
- Doctor can **listen to the stored voice note** from previous consultations via the embedded player.
- Doctor records a **new follow-up consultation log** with updated diagnosis, medicines, and a new voice note.
- **DO NOT delete the previous log**: The system appends a new immutable visit entry.
- Doctor can view **both/all logs side-by-side or chronologically with Date and Time**.

---

## ⚙️ Core Distributed Systems Challenges

```
┌────────────────────────────────────────────────────────┐
│             Offline Village Clinic Device              │
│  ┌─────────────────────────┐  ┌─────────────────────┐  │
│  │   IndexedDB Encrypted   │  │   MediaRecorder     │  │
│  │    Storage (AES-GCM)    │  │   Offline Audio     │  │
│  └───────────┬─────────────┘  └──────────┬──────────┘  │
│              │                           │             │
│              ▼                           ▼             │
│  ┌──────────────────────────────────────────────────┐  │
│  │        Hybrid Logical Clock (l, c, node_id)      │  │
│  └──────────────────────────┬───────────────────────┘  │
│                             │                          │
│                             ▼                          │
│  ┌──────────────────────────────────────────────────┐  │
│  │   Domain-Aware CRDT & Unsafe Conflict Detector   │  │
│  └──────────────────────────┬───────────────────────┘  │
└─────────────────────────────┼──────────────────────────┘
                              │ Weak Link (2G / Satellite)
                              ▼
┌────────────────────────────────────────────────────────┐
│             Resumable Delta Sync Checkpoint            │
│       • Idempotent Replay via SHA-256 Hashing          │
│       • Zero Data-Loss Monotonic Append-Only Log       │
│       • Explicit Doctor Conflict Resolution Modal      │
└────────────────────────────────────────────────────────┘
```

### 1. Hybrid Logical Clocks (HLC)
- Implements the Kulkarni algorithm: $HLC = (l, c, node\_id)$.
- Handles arbitrary clock drift and out-of-order clock synchronization across offline field devices.
- Ensures a strict partial order: $e_1 \to e_2 \implies HLC(e_1) < HLC(e_2)$.

### 2. Domain-Aware Merge Semantics vs Unsafe Conflicts
- **Safe Automatic Merge (Monotonic Encounter Logs)**: All visit consultations are modeled as an append-only set CRDT. Concurrent visits logged at different clinics are merged commutatively and associatively without loss.
- **Unsafe Automatic Merge Detection**: If two offline devices concurrently alter sensitive clinical fields (such as conflicting primary diagnoses, incompatible prescriptions, or core demographics), Last-Write-Wins (LWW) is **rejected**.
- Instead, the system triggers an **Explicit Conflict Resolution Modal** where the physician inspects differences and decides whether to keep Local, accept Remote, or combine both into a unified record.

### 3. Resumable Delta Sync & Weak Link Simulation
- Emulates rural 2G (700ms latency, 9.6 kbps throughput, 15% packet drop) and satellite links.
- Uses a **checkpointed vector**: deltas are batched into small chunks.
- **Interrupted Sync Recovery**: Users can simulate dropping connection at 40%; upon reconnection, sync resumes from the last acknowledged checkpoint without re-transmitting already acknowledged records.

### 4. Idempotent Replay & Encryption at Rest
- Every delta carries a cryptographic SHA-256 hash. Re-transmitting or replaying deltas produces zero duplicates.
- All stored medical data and voice recordings are encrypted locally using the Web Crypto API (`AES-GCM-256` with PBKDF2 key derivation).

---

## 🚀 How to Run the Project

### Option A: Pure Standalone Offline Browser Mode (Zero Setup!)
Open `index.html` in any web browser (Chrome, Edge, Brave, Firefox):
```powershell
Start-Process "c:\Users\Prannav\Desktop\Hackathon project\index.html"
```
*Note: All dependencies (`qrcode.min.js`, `jsQR.min.js`) are stored locally inside `libs/`. No internet connection required!*

### Option B: With Python Weak-Link Sync Server
To run the local clinic hub relay server:
```powershell
& "C:\Program Files\LibreOffice\program\python.exe" "c:\Users\Prannav\Desktop\Hackathon project\server\sync_server.py"
```
Then visit: `http://localhost:8080`

---

## 🧪 Hackathon Judge Step-by-Step Demonstration

1. **Step 1: Open the Application**
   - Click the link or open `index.html`.
   - Observe the **Landing View** matching Sketch 1 (`[ + NEW PATIENT ]` or `[ 📷 EXISTING PATIENT (SCAN QR) ]`).
2. **Step 2: Register a New Patient (Sketch 2)**
   - Click `+ NEW PATIENT`.
   - Enter Name (e.g. *Rajesh Patel*), Age (*42*), Gender (*Male*).
   - Select Disease Type: `[CRN] Chronic Disease`.
   - Choose medication: `Metformin 500mg Tab` (click `+ Metformin 500mg` chip).
   - Click `🎙️ Record Voice Note` to record doctor instructions via microphone, or click `🎵 Add Demo Audio Chime`.
   - Note the dynamically generated Unique ID and **QR Code**.
   - Click `💾 Save Patient Record to Local Database`.
3. **Step 3: Scan QR & View History with Voice Notes**
   - Go to `Sheet 1: Clinic Home` and click `📷 EXISTING PATIENT (SCAN QR)`.
   - Scan with webcam or click `👤 Test with Demo Patient (Sunita Devi)`.
   - Click `▶ Listen Voice Note` to listen to the stored voice recording!
4. **Step 4: Record a New Follow-up Log (Preserve All Past Logs)**
   - Scroll down to the `➕ Record New Consultation / Follow-up Visit Log` section.
   - Enter new notes (e.g. *"Fever resolved, patient reports mild dry cough"*).
   - Select medicine `Cetirizine 10mg Tab` and record a new voice note.
   - Click `💾 Append New Visit Log (Preserve All Past Logs)`.
   - **Notice that both Visit Log #1 and Visit Log #2 are displayed chronologically with their respective dates, times, prescriptions, and playable voice notes!**
5. **Step 5: View the Master Spreadsheet**
   - Click `📊 Sheet 5: Spreadsheet Ledger` to view all patients in a classic Excel-like table.
6. **Step 6: Weak-Link Resumable Sync & Explicit Conflict Test**
   - Click `🔄 Sync & CRDT Monitor`.
   - Click `🚀 Run Delta Sync` to watch chunked delta transfer over simulated 2G.
   - Click `⚡ Interrupt Sync Midway` to observe **resumable checkpoint recovery**.
   - Click `⚠️ Simulate Concurrent Conflicting Edit from Van-02`.
   - Watch the **Explicit Conflict Resolution Modal** pop up! Inspect Local vs Remote side-by-side and resolve it safely.
   - Verify that **Data-Loss Rate** remains strictly **0.00%**!

---

## ☁️ Multi-Device Cloud Sync (Vercel + Neon Postgres)

Every device keeps working **offline** (IndexedDB). Changes are queued as deltas and, whenever a device is online, it
**uploads** its queue to a shared cloud database and **downloads** what other devices uploaded.
Patients, visit logs and voice notes registered on any device show up on every other device after a sync
(automatic every 30 s, ~3 s after a save, when the connection returns, or press **Run Delta Sync**).

### One-time setup
1. **Database** – Vercel dashboard → your project → **Storage** → **Create Database** → **Neon (Postgres)** → connect it to the project.
   This adds `DATABASE_URL` automatically. (The tables are created on first use.)
2. **Clinic key (optional)** – By default the hub is **open**: any device that opens the site syncs automatically, no key needed (fine for demos with fake data).
   To lock it down, add `CLINIC_SYNC_KEY` = a long secret under **Settings → Environment Variables**, then enter the same key on each device (or use **Set Up Another Device**).
3. **Redeploy** (Deployments → ⋯ → Redeploy) so the variables take effect.
4. Open the site on each device. Syncing starts by itself; the **Sync & CRDT Monitor** tab shows a green status. Optionally give each device a name (e.g. `VAN-02`) there.

### How merging works
- Visit logs and voice notes are append-only → merged by set union, never lost.
- A patient edit carries `baseHlc` (the version it was built on). If it builds on what the receiver has, it fast-forwards;
  if two devices edited the same patient **concurrently** and disagree on diagnosis/prescription/demographics, a **conflict**
  is raised and the doctor chooses (keep local / accept remote / combine). Nothing is silently overwritten.
- The hub assigns each delta a sequence number; devices pull "everything after my last cursor", so an interrupted sync resumes exactly where it stopped.

### API
| Endpoint | Purpose |
|---|---|
| `POST /api/sync` | Upload deltas `{deltas:[...]}` (header `x-clinic-key`) |
| `GET /api/sync?since=<seq>` | Download deltas after a cursor |
| `GET /api/status` | Health check (database, key configured) |

> Note: the old `server/sync_server.py` is a local-only demo relay and is no longer used by the app.
