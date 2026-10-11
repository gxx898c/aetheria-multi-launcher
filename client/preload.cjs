// สิ่งที่หน้าเกมเรียกใช้จากตัวเปิดเกมได้ (เหมือนตัวทางการ Aetheria Online 1.0.4)
// ปุ่ม "เข้าสู่ระบบด้วย Google" ในเกมเรียก googleLogin() → main.cjs เปิดหน้าล็อกอินในเบราว์เซอร์ของผู้เล่น แล้วคืน token ให้เกม
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aetheriaDesktop', {
  googleLogin: () => ipcRenderer.invoke('google-login'),
});
