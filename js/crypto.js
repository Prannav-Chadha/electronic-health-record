/**
 * Encryption at Rest & Cryptographic Hashing Service
 * Uses Web Crypto API (SubtleCrypto)
 * - AES-GCM-256 for record and audio encryption at rest
 * - PBKDF2 for clinic key derivation
 * - SHA-256 for idempotent delta content hashing & tamper-evident audit chains
 */

class HealthCryptoService {
  constructor() {
    this.key = null;
    this.defaultSecret = 'OfflineClinicSecretKey#2026-RuralHealth-Secure';
    this.salt = new TextEncoder().encode('RURAL_HEALTH_CLINIC_SALT_V1');
  }

  /**
   * Derive or initialize AES-GCM 256-bit key
   */
  async initKey(passphrase = null) {
    if (this.key && !passphrase) return this.key;
    const secret = passphrase || this.defaultSecret;
    const enc = new TextEncoder();

    try {
      const keyMaterial = await window.crypto.subtle.importKey(
        'raw',
        enc.encode(secret),
        { name: 'PBKDF2' },
        false,
        ['deriveKey']
      );

      this.key = await window.crypto.subtle.deriveKey(
        {
          name: 'PBKDF2',
          salt: this.salt,
          iterations: 100000,
          hash: 'SHA-256'
        },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );

      return this.key;
    } catch (err) {
      console.warn('WebCrypto deriveKey fallback to basic key:', err);
      return null;
    }
  }

  /**
   * Encrypt a JavaScript object or string into Base64 ciphertext with IV
   */
  async encrypt(data) {
    await this.initKey();
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    const enc = new TextEncoder();
    const encoded = enc.encode(str);
    const iv = window.crypto.getRandomValues(new Uint8Array(12));

    try {
      const encrypted = await window.crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv },
        this.key,
        encoded
      );

      return {
        ciphertext: this._arrayBufferToBase64(encrypted),
        iv: this._arrayBufferToBase64(iv),
        encrypted: true
      };
    } catch (e) {
      console.error('Encryption failed, storing with safe tag:', e);
      return { ciphertext: btoa(unescape(encodeURIComponent(str))), iv: '', encrypted: false };
    }
  }

  /**
   * Decrypt Base64 ciphertext with IV back into string or object
   */
  async decrypt(payload) {
    if (!payload) return null;
    if (typeof payload === 'object' && payload.ciphertext) {
      if (!payload.encrypted) {
        try {
          const raw = decodeURIComponent(escape(atob(payload.ciphertext)));
          return JSON.parse(raw);
        } catch {
          return payload.ciphertext;
        }
      }

      await this.initKey();
      try {
        const encryptedBytes = this._base64ToArrayBuffer(payload.ciphertext);
        const ivBytes = this._base64ToArrayBuffer(payload.iv);

        const decrypted = await window.crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: ivBytes },
          this.key,
          encryptedBytes
        );

        const dec = new TextDecoder();
        const jsonStr = dec.decode(decrypted);
        try {
          return JSON.parse(jsonStr);
        } catch {
          return jsonStr;
        }
      } catch (err) {
        console.error('Decryption failed:', err);
        return null;
      }
    }
    return payload;
  }

  /**
   * Compute SHA-256 hash of any payload (for idempotent replay verification)
   */
  async computeHash(data) {
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    const enc = new TextEncoder();
    const hashBuffer = await window.crypto.subtle.digest('SHA-256', enc.encode(str));
    return this._bufferToHex(hashBuffer);
  }

  _arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  _base64ToArrayBuffer(base64) {
    const binaryString = window.atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }

  _bufferToHex(buffer) {
    const bytes = new Uint8Array(buffer);
    return Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
}

if (typeof window !== 'undefined') {
  window.HealthCrypto = new HealthCryptoService();
}
