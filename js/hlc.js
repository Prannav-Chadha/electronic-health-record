/**
 * Hybrid Logical Clock (HLC) Implementation
 * Based on Kulkarni et al. "Logical Physical Clocks and Consistent Snapshots in Globally Distributed Databases"
 * Guarantees strict causality tracking: e1 -> e2 implies HLC(e1) < HLC(e2)
 * Tolerates clock drift and enables deterministic distributed ordering across offline village clinics.
 */

class HLC {
  constructor(l = 0, c = 0, node = 'NODE-01') {
    this.l = typeof l === 'number' ? l : parseInt(l, 10); // Physical wall-clock component (ms)
    this.c = typeof c === 'number' ? c : parseInt(c, 10); // Logical counter component
    this.node = String(node);                             // Unique node identifier
  }

  /**
   * Clone current HLC
   */
  clone() {
    return new HLC(this.l, this.c, this.node);
  }

  /**
   * Compare two HLC timestamps: returns -1 if a < b, 1 if a > b, 0 if a == b
   */
  static compare(a, b) {
    if (!a || !b) return 0;
    if (a.l !== b.l) {
      return a.l < b.l ? -1 : 1;
    }
    if (a.c !== b.c) {
      return a.c < b.c ? -1 : 1;
    }
    if (a.node !== b.node) {
      return a.node < b.node ? -1 : 1;
    }
    return 0;
  }

  /**
   * Check if this HLC causally dominates or is equal to another
   */
  isNewerThan(other) {
    return HLC.compare(this, other) > 0;
  }

  /**
   * Check if two HLCs are concurrent (neither happened before the other)
   * Note: With total ordering by node ID, concurrent events get a deterministic tiebreak,
   * but domain-level conflict detection needs to know if their physical/logical times overlap.
   */
  static areConcurrent(a, b, clockToleranceMs = 1000) {
    if (!a || !b) return false;
    // Events generated on different nodes within the same causal window without ancestry
    const timeDiff = Math.abs(a.l - b.l);
    return a.node !== b.node && timeDiff < clockToleranceMs && Math.abs(a.c - b.c) <= 2;
  }

  /**
   * Serialize HLC to string: "l:c:node"
   */
  toString() {
    return `${this.l}:${this.c}:${this.node}`;
  }

  /**
   * Human readable formatted string with real date & counter
   */
  toReadableString() {
    const d = new Date(this.l);
    const dateStr = d.toISOString().replace('T', ' ').substring(0, 19);
    return `${dateStr}.${String(this.l % 1000).padStart(3, '0')} (c:${this.c}) [${this.node}]`;
  }

  /**
   * Parse HLC from string: "l:c:node"
   */
  static parse(str) {
    if (!str) return new HLC(Date.now(), 0, 'NODE-01');
    if (typeof str === 'object' && str.l !== undefined) {
      return new HLC(str.l, str.c, str.node);
    }
    const parts = String(str).split(':');
    if (parts.length >= 3) {
      return new HLC(parseInt(parts[0], 10), parseInt(parts[1], 10), parts.slice(2).join(':'));
    }
    return new HLC(Date.now(), 0, 'NODE-01');
  }
}

class HybridLogicalClockService {
  constructor(nodeId = 'VILLAGE-CLINIC-01') {
    this.nodeId = nodeId;
    this.l = Date.now();
    this.c = 0;
  }

  setNodeId(newNodeId) {
    this.nodeId = newNodeId;
  }

  /**
   * Generates a new HLC for a local send or create event
   */
  now() {
    const pt = Date.now();
    if (pt > this.l) {
      this.l = pt;
      this.c = 0;
    } else {
      this.c += 1;
    }
    return new HLC(this.l, this.c, this.nodeId);
  }

  /**
   * Advances local HLC on receiving a message/delta from another node
   */
  update(remoteHlc) {
    if (!remoteHlc) return this.now();
    const remote = typeof remoteHlc === 'string' ? HLC.parse(remoteHlc) : remoteHlc;
    const pt = Date.now();
    const lOld = this.l;
    const cOld = this.c;

    this.l = Math.max(lOld, remote.l, pt);

    if (this.l === lOld && this.l === remote.l) {
      this.c = Math.max(cOld, remote.c) + 1;
    } else if (this.l === lOld) {
      this.c = cOld + 1;
    } else if (this.l === remote.l) {
      this.c = remote.c + 1;
    } else {
      this.c = 0;
    }

    return new HLC(this.l, this.c, this.nodeId);
  }

  /**
   * Current snapshot of the clock
   */
  getSnapshot() {
    return new HLC(this.l, this.c, this.nodeId);
  }
}

// Global instance for browser window
if (typeof window !== 'undefined') {
  window.HLC = HLC;
  window.hlcService = new HybridLogicalClockService('CLINIC-MAIN');
}
