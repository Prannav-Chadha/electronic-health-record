/**
 * QR Code Generator & Scanner Engine for Village EHR
 * 1. Generates patient QR cards with Unique ID using local qrcode.min.js
 * 2. Scans live QR code via device camera using local jsQR.min.js
 * 3. Scans uploaded QR code image files instantly offline
 */

class HealthQRService {
  constructor() {
    this.videoStream = null;
    this.scanInterval = null;
    this.isScanning = false;
  }

  /**
   * Generate a unique Patient ID
   * Format: EHR-VIL-XXXX (e.g. EHR-VIL-4921)
   */
  generateUniquePatientId() {
    const randomDigits = Math.floor(1000 + Math.random() * 9000);
    const alpha = Math.random().toString(36).substring(2, 5).toUpperCase();
    return `EHR-${alpha}-${randomDigits}`;
  }

  /**
   * Render QR code in a DOM element
   */
  renderQRCode(containerElement, text, size = 180) {
    if (!containerElement) return null;
    containerElement.innerHTML = '';

    if (typeof QRCode !== 'undefined') {
      try {
        return new QRCode(containerElement, {
          text: String(text),
          width: size,
          height: size,
          colorDark: '#0b2b13',
          colorLight: '#ffffff',
          correctLevel: QRCode.CorrectLevel.H
        });
      } catch (err) {
        console.warn('QRCode generation fallback:', err);
      }
    }

    // Fallback: SVG QR representation if library is still initializing
    containerElement.innerHTML = `<div style="padding: 10px; border: 2px dashed #2e7d32; text-align: center; font-weight: bold; font-family: monospace;">[QR: ${text}]</div>`;
    return null;
  }

  /**
   * Start Live Camera QR Scanner
   * @param {HTMLVideoElement} videoElement
   * @param {HTMLCanvasElement} canvasElement
   * @param {Function} onScanSuccess callback when QR is detected
   */
  async startCameraScanner(videoElement, canvasElement, onScanSuccess) {
    if (!videoElement || !canvasElement) return false;
    this.isScanning = true;

    try {
      this.videoStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }
      });
      videoElement.srcObject = this.videoStream;
      videoElement.setAttribute('playsinline', true);
      await videoElement.play();

      const ctx = canvasElement.getContext('2d', { willReadFrequently: true });

      const checkFrame = () => {
        if (!this.isScanning) return;

        if (videoElement.readyState === videoElement.HAVE_ENOUGH_DATA) {
          canvasElement.height = videoElement.videoHeight;
          canvasElement.width = videoElement.videoWidth;
          ctx.drawImage(videoElement, 0, 0, canvasElement.width, canvasElement.height);

          const imageData = ctx.getImageData(0, 0, canvasElement.width, canvasElement.height);
          if (typeof jsQR !== 'undefined') {
            const code = jsQR(imageData.data, imageData.width, imageData.height, {
              inversionAttempts: 'dontInvert'
            });

            if (code && code.data) {
              console.log('✅ QR Code detected:', code.data);
              this.stopCameraScanner();
              onScanSuccess(code.data.trim());
              return;
            }
          }
        }

        this.scanInterval = requestAnimationFrame(checkFrame);
      };

      this.scanInterval = requestAnimationFrame(checkFrame);
      return true;
    } catch (err) {
      console.warn('Camera scanner failed or permission denied:', err);
      return false;
    }
  }

  /**
   * Stop Live Camera Scanner
   */
  stopCameraScanner() {
    this.isScanning = false;
    if (this.scanInterval) {
      cancelAnimationFrame(this.scanInterval);
      this.scanInterval = null;
    }
    if (this.videoStream) {
      this.videoStream.getTracks().forEach(t => t.stop());
      this.videoStream = null;
    }
  }

  /**
   * Decode QR Code from an uploaded Image file
   */
  async decodeFromImageFile(file) {
    return new Promise((resolve, reject) => {
      if (!file) return resolve(null);
      const reader = new FileReader();

      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);

          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          if (typeof jsQR !== 'undefined') {
            const code = jsQR(imageData.data, imageData.width, imageData.height);
            if (code && code.data) {
              resolve(code.data.trim());
              return;
            }
          }
          resolve(null);
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }
}

if (typeof window !== 'undefined') {
  window.healthQR = new HealthQRService();
}
