/**
 * Offline Voice Note Recorder & Audio Player
 * Uses Web Audio / MediaRecorder API
 * Records doctor voice notes, compresses to Base64, and stores in IndexedDB
 * Works 100% offline with zero external cloud dependencies.
 */

class HealthAudioService {
  constructor() {
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.isRecording = false;
    this.recordTimer = null;
    this.secondsRecorded = 0;
    this.currentStream = null;
  }

  /**
   * Start recording from microphone
   */
  async startRecording(onTick = null) {
    this.audioChunks = [];
    this.secondsRecorded = 0;

    try {
      this.currentStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.mediaRecorder = new MediaRecorder(this.currentStream);

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      this.mediaRecorder.start(250); // slice every 250ms
      this.isRecording = true;

      if (onTick) {
        this.recordTimer = setInterval(() => {
          this.secondsRecorded++;
          onTick(this.secondsRecorded);
        }, 1000);
      }

      return { success: true };
    } catch (err) {
      console.warn('Microphone access unavailable or denied:', err);
      return {
        success: false,
        error: 'Microphone access denied or unavailable. You can also upload an audio clip or generate a demo voice note.'
      };
    }
  }

  /**
   * Stop recording and return base64 audio and duration
   */
  async stopRecording() {
    if (!this.isRecording || !this.mediaRecorder) {
      return null;
    }

    clearInterval(this.recordTimer);
    this.isRecording = false;

    return new Promise((resolve) => {
      this.mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
        
        // Stop stream tracks to turn off mic light
        if (this.currentStream) {
          this.currentStream.getTracks().forEach(track => track.stop());
        }

        const base64 = await this._blobToBase64(audioBlob);
        const voiceNoteId = 'VN-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6);

        resolve({
          voiceNoteId,
          audioBase64: base64,
          durationSec: this.secondsRecorded || 1,
          mimeType: 'audio/webm'
        });
      };

      this.mediaRecorder.stop();
    });
  }

  /**
   * Generate an offline simulated voice note for testing or demoing without mic
   */
  createDemoVoiceNote(doctorName = 'Dr. Sharma', notes = 'Patient presents with severe viral fever.') {
    // Generate a pleasant synth audio beep / chime using Web Audio API offline
    return new Promise((resolve) => {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const sampleRate = 16000;
        const duration = 2.5; // 2.5 seconds
        const buffer = ctx.createBuffer(1, sampleRate * duration, sampleRate);
        const data = buffer.getChannelData(0);

        for (let i = 0; i < sampleRate * duration; i++) {
          const t = i / sampleRate;
          // Harmonic consultation chime (A4 + E5 tone)
          data[i] = (Math.sin(2 * Math.PI * 440 * t) * 0.3 + Math.sin(2 * Math.PI * 659.25 * t) * 0.2) * Math.exp(-t * 0.8);
        }

        const wavBlob = this._bufferToWave(buffer, sampleRate * duration);
        this._blobToBase64(wavBlob).then(base64 => {
          resolve({
            voiceNoteId: 'VN-DEMO-' + Date.now(),
            audioBase64: base64,
            durationSec: 3,
            mimeType: 'audio/wav',
            noteText: `[Voice Note Simulation: "${notes}" - Recorded by ${doctorName}]`
          });
        });
      } catch (e) {
        console.warn('Web Audio synthesis failed, returning placeholder:', e);
        resolve({
          voiceNoteId: 'VN-DEMO-' + Date.now(),
          audioBase64: '',
          durationSec: 3,
          mimeType: 'audio/wav',
          noteText: `[Voice Note: "${notes}"]`
        });
      }
    });
  }

  _blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  _bufferToWave(abuffer, len) {
    const numOfChan = abuffer.numberOfChannels;
    const length = len * numOfChan * 2 + 44;
    const out = new DataView(new ArrayBuffer(length));
    const channels = [];
    let sample = 0;
    let offset = 0;
    let pos = 0;

    function setUint16(data) { out.setUint16(pos, data, true); pos += 2; }
    function setUint32(data) { out.setUint32(pos, data, true); pos += 4; }

    setUint32(0x46464952); // "RIFF"
    setUint32(length - 8); // file length - 8
    setUint32(0x45564157); // "WAVE"
    setUint32(0x20746d66); // "fmt " chunk
    setUint32(16);         // length = 16
    setUint16(1);          // PCM (uncompressed)
    setUint16(numOfChan);
    setUint32(abuffer.sampleRate);
    setUint32(abuffer.sampleRate * 2 * numOfChan); // avg. bytes/sec
    setUint16(numOfChan * 2);                      // block-align
    setUint16(16);                                 // 16-bit
    setUint32(0x61746164);                         // "data" - chunk
    setUint32(length - pos - 4);                   // chunk length

    for (let i = 0; i < abuffer.numberOfChannels; i++) {
      channels.push(abuffer.getChannelData(i));
    }

    while (pos < length) {
      for (let i = 0; i < numOfChan; i++) {
        sample = Math.max(-1, Math.min(1, channels[i][offset]));
        sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0;
        out.setInt16(pos, sample, true);
        pos += 2;
      }
      offset++;
    }
    return new Blob([out], { type: 'audio/wav' });
  }
}

if (typeof window !== 'undefined') {
  window.healthAudio = new HealthAudioService();
}
