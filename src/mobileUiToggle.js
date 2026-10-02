/**
 * 2026-10-02: 移动端一键隐藏/显示 UI 面板
 * 在屏幕右下角加一个悬浮按钮，点击切换所有面板的显示/隐藏，
 * 方便手机上看干净的 3D 画面。
 */
function initMobileUIToggle() {
  if (document.getElementById('gev-ui-toggle')) return;

  const style = document.createElement('style');
  style.textContent = `
    #gev-ui-toggle {
      position: fixed;
      right: 12px;
      bottom: 12px;
      z-index: 99999;
      width: 48px;
      height: 48px;
      border-radius: 50%;
      border: 1px solid rgba(0, 255, 255, 0.4);
      background: rgba(0, 20, 30, 0.85);
      color: #0ff;
      font-size: 22px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      backdrop-filter: blur(4px);
      -webkit-tap-highlight-color: transparent;
      user-select: none;
    }
    #gev-ui-toggle:active { transform: scale(0.92); }
    body.gev-hide-ui #left-panel-stack,
    body.gev-hide-ui #right-panel-stack,
    body.gev-hide-ui .command-dock,
    body.gev-hide-ui #hud-top-bar,
    body.gev-hide-ui .hud-panel {
      display: none !important;
    }
  `;
  document.head.appendChild(style);

  const btn = document.createElement('button');
  btn.id = 'gev-ui-toggle';
  btn.title = '隐藏/显示界面';
  btn.textContent = '👁';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const hidden = document.body.classList.toggle('gev-hide-ui');
    btn.textContent = hidden ? '👁‍🗨' : '👁';
  });
  document.body.appendChild(btn);
}

// DOM 就绪后注入（app 是异步启动的，按钮独立于 app 生命周期）
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initMobileUIToggle);
} else {
  initMobileUIToggle();
}
// 兜底：app 晚加载时再试一次
setTimeout(initMobileUIToggle, 3000);

export { initMobileUIToggle };
