(() => {
  const LS_DONE = "rb_bt_tutorial_done_v3";
  const REPOSITION_MS = 250;

  const STEPS = [
    {
      title: "Увімкни машинку",
      text: "Перед підключенням увімкни живлення машинки та переконайся, що модуль Bluetooth активний.",
      note: "Далі покажу, де саме запускати підключення на сайті.",
    },
    {
      title: "Перевір підтримку Bluetooth",
      text: "Для підключення потрібен браузер, де працює Web Bluetooth.",
      note: "У Safari, Firefox та на більшості iPhone це не працює.",
    },
    {
      title: "Натисни кнопку «BT»",
      text: "Кнопка Bluetooth знаходиться у верхньому правому куті. Вона відкриває вікно підключення до машинки.",
      selector: "#btConnect",
      autoNextOnClick: "#btConnect",
      onShow() {
        closeBtModalSafe();
      },
    },
    {
      title: "Натисни «Сканувати»",
      text: "Натисни кнопку «Сканувати», і браузер покаже список доступних пристроїв.",
      note: "Після цього браузер відкриє список доступних Bluetooth-пристроїв.",
      selector: "#btScanBtn",
      autoNextOnClick: "#btScanBtn",
      ensureBtModalOpen: true,
      onShow() {
        openBtModalSafe();
        resetBtModalSafe();
      },
    },
    {
      title: "Обери свою машинку",
      text: "У системному списку Bluetooth-пристроїв обери саме свою машинку.",
      note: "Якщо її нема у списку, перевір чи машинка увімкнена і чи ти відкрив сайт у Chrome.",
      selector: "#btModal",
      ensureBtModalOpen: true,
      onShow() {
        openBtModalSafe();
      },
    },
    {
      title: "Перевір індикатор",
      text() {
        return window.isConnected
          ? "Крапка у заголовку вже зелена — машинка підключена."
          : "Після успішного вибору машинки крапка у заголовку стане зеленою — це означає, що машинка підключена.";
      },
      note: "Ще один останній пункт: якщо забудеш, навчання можна буде запустити ще раз із налаштувань.",
      selector: "#statusDot",
      onShow() {
        closeBtModalSafe();
      },
    },
    {
      title: "Як пройти навчання ще раз",
      text: "Якщо потім забудеш, як підключати машинку, відкрий Налаштування і натисни кнопку «Пройти навчання ще раз».",
      note: "Ця кнопка завжди буде в кінці списку налаштувань.",
      selector: "#settingsTutorialBtn",
      onShow() {
        closeBtModalSafe();
        if (typeof window.openSettings === "function") window.openSettings();
      },
    },
  ];

  const state = {
    active: false,
    stepIndex: 0,
    enteredStep: -1,
    autoNextCleanup: null,
    statusObserver: null,
    repositionTimer: null,
    robotAnimation: null,
  };

  const q = (selector) => document.querySelector(selector);
  const byId = (id) => document.getElementById(id);

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function getStep(index) {
    return STEPS[clamp(index, 0, STEPS.length - 1)];
  }

  function isDone() {
    try {
      return localStorage.getItem(LS_DONE) === "1";
    } catch (err) {
      return false;
    }
  }

  function markDone() {
    try {
      localStorage.setItem(LS_DONE, "1");
    } catch (err) {}
  }

  function resolveText(value) {
    return typeof value === "function" ? value() : value || "";
  }

  function getRect(el) {
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (!rect || rect.width < 2 || rect.height < 2) return null;
    return rect;
  }

  function isVisible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  function resolveTarget(selector) {
    if (!selector) return null;
    const el = q(selector);
    if (!el || !isVisible(el)) return null;
    return getRect(el) ? el : null;
  }

  function rectsOverlap(a, b) {
    if (!a || !b) return false;
    return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
  }

  function openBtModalSafe() {
    if (typeof window.openBtModal === "function") window.openBtModal();
  }

  function closeBtModalSafe() {
    if (typeof window.closeBtModal === "function") window.closeBtModal();
  }

  function resetBtModalSafe() {
    if (typeof window.resetBtModal === "function") window.resetBtModal();
  }

  function ensureDom() {
    if (byId("raRobot")) return;

    document.body.insertAdjacentHTML(
      "beforeend",
      `
<div id="raDim"></div>
<div id="raSpot"></div>
<div id="raRobot"><div id="raRobotAnim" class="ra-robot-anim"></div></div>
<div id="raTutorial">
  <div id="raStepHead" class="ra-head"></div>
  <div id="raStepTitle" class="ra-title"></div>
  <div id="raStepText" class="ra-text"></div>
  <div id="raStepNote" class="ra-note" style="display:none"></div>
  <div class="ra-actions">
    <button id="raPrev" class="ra-btn ra-btn-dark">Назад</button>
    <button id="raNext" class="ra-btn ra-btn-main">Далі</button>
    <button id="raClose" class="ra-btn ra-btn-dark">Закрити</button>
  </div>
</div>
`
    );

    byId("raPrev").addEventListener("click", prevStep);
    byId("raNext").addEventListener("click", nextStep);
    byId("raClose").addEventListener("click", closeTutorial);

    initRobotAnimation();
  }

  function initRobotAnimation() {
    if (state.robotAnimation || !window.lottie) return;
    const host = byId("raRobotAnim");
    if (!host) return;

    try {
      state.robotAnimation = window.lottie.loadAnimation({
        container: host,
        renderer: "svg",
        loop: true,
        autoplay: true,
        path: "assets/bt-tour-robot/robot.json",
        assetsPath: "assets/bt-tour-robot/",
        rendererSettings: {
          preserveAspectRatio: "xMidYMid meet",
        },
      });
    } catch (err) {
      host.className = "ra-robot-fallback";
      host.textContent = "🤖";
    }
  }

  function showGuides(targetRect) {
    const dim = byId("raDim");
    const spot = byId("raSpot");

    if (dim) dim.classList.add("show");

    if (!spot || !targetRect) {
      if (spot) spot.style.opacity = "0";
      return;
    }

    const pad = 8;
    spot.style.left = `${targetRect.left - pad}px`;
    spot.style.top = `${targetRect.top - pad}px`;
    spot.style.width = `${targetRect.width + pad * 2}px`;
    spot.style.height = `${targetRect.height + pad * 2}px`;
    spot.style.opacity = "1";
  }

  function hideGuides() {
    byId("raDim")?.classList.remove("show");
    const spot = byId("raSpot");
    if (spot) spot.style.opacity = "0";
  }

  function placeRobot(targetRect) {
    const robot = byId("raRobot");
    if (!robot) return;

    robot.style.display = "flex";

    const width = robot.offsetWidth || 78;
    const height = robot.offsetHeight || 78;
    let x = 24;
    let y = 24;

    if (targetRect) {
      x = targetRect.left - width - 18;
      if (x < 8) x = targetRect.right + 18;
      x = clamp(x, 8, window.innerWidth - width - 8);
      y = clamp(targetRect.top + targetRect.height / 2 - height / 2, 8, window.innerHeight - height - 8);
    }

    robot.style.setProperty("--tx", `${x}px`);
    robot.style.setProperty("--ty", `${y}px`);
    robot.style.transform = `translate(${x}px, ${y}px)`;
  }

  function placeBubble(targetRect) {
    const bubble = byId("raTutorial");
    const robot = byId("raRobot");
    if (!bubble || !robot) return;

    const robotRect = robot.getBoundingClientRect();
    const bw = bubble.offsetWidth || 448;
    const bh = bubble.offsetHeight || 180;
    const candidates = [
      { x: robotRect.right + 12, y: robotRect.top + 2 },
      { x: robotRect.left - bw - 12, y: robotRect.top + 2 },
      { x: robotRect.left + robotRect.width / 2 - bw / 2, y: robotRect.bottom + 10 },
      { x: robotRect.left + robotRect.width / 2 - bw / 2, y: robotRect.top - bh - 10 },
      { x: window.innerWidth - bw - 10, y: 10 },
      { x: 10, y: window.innerHeight - bh - 10 },
    ];

    let chosen = null;
    for (const item of candidates) {
      const x = clamp(item.x, 8, window.innerWidth - bw - 8);
      const y = clamp(item.y, 8, window.innerHeight - bh - 8);
      const rect = { left: x, top: y, right: x + bw, bottom: y + bh };
      if (!targetRect || !rectsOverlap(rect, targetRect)) {
        chosen = { x, y };
        break;
      }
    }

    if (!chosen) {
      chosen = {
        x: clamp(window.innerWidth - bw - 10, 8, window.innerWidth - bw - 8),
        y: clamp(window.innerHeight - bh - 10, 8, window.innerHeight - bh - 8),
      };
    }

    bubble.style.display = "block";
    bubble.classList.add("open");
    bubble.style.transform = `translate(${chosen.x}px, ${chosen.y}px)`;
  }

  function clearAutoNext() {
    if (typeof state.autoNextCleanup === "function") state.autoNextCleanup();
    state.autoNextCleanup = null;
  }

  function bindAutoNext(step) {
    clearAutoNext();
    if (!step.autoNextOnClick) return;

    const target = resolveTarget(step.autoNextOnClick) || q(step.autoNextOnClick);
    if (!target) return;

    const handler = () => {
      setTimeout(() => {
        if (state.active) nextStep();
      }, 160);
    };

    target.addEventListener("click", handler, { once: true });
    state.autoNextCleanup = () => target.removeEventListener("click", handler);
  }

  function renderStep() {
    const step = getStep(state.stepIndex);
    bindAutoNext(step);

    if (state.enteredStep !== state.stepIndex) {
      state.enteredStep = state.stepIndex;
      if (step.ensureBtModalOpen) openBtModalSafe();
      if (typeof step.onShow === "function") step.onShow();
    }

    byId("raStepHead").textContent = `BLUETOOTH НАВЧАННЯ ${state.stepIndex + 1}/${STEPS.length}`;
    byId("raStepTitle").textContent = step.title;
    byId("raStepText").textContent = resolveText(step.text);
    byId("raPrev").style.visibility = state.stepIndex === 0 ? "hidden" : "visible";
    byId("raNext").textContent = state.stepIndex === STEPS.length - 1 ? "Готово" : "Далі";
    byId("raTutorial").style.display = "block";
    byId("raTutorial").classList.add("open");

    const note = byId("raStepNote");
    const noteText = resolveText(step.note);
    note.textContent = noteText;
    note.style.display = noteText ? "" : "none";

    const target = resolveTarget(step.selector);
    const targetRect = getRect(target);
    showGuides(targetRect);
    placeRobot(targetRect);

    requestAnimationFrame(() => {
      placeBubble(targetRect);
    });
  }

  function repositionActiveStep() {
    if (!state.active) return;
    const step = getStep(state.stepIndex);
    const target = resolveTarget(step.selector);
    const targetRect = getRect(target);
    showGuides(targetRect);
    placeRobot(targetRect);
    placeBubble(targetRect);
  }

  function scheduleReposition() {
    if (!state.active) return;
    clearTimeout(state.repositionTimer);
    state.repositionTimer = setTimeout(repositionActiveStep, REPOSITION_MS);
  }

  function startTutorial(force) {
    ensureDom();
    if (!force && isDone()) return;

    state.active = true;
    state.stepIndex = 0;
    state.enteredStep = -1;
    renderStep();
  }

  function closeTutorial() {
    state.active = false;
    state.stepIndex = 0;
    state.enteredStep = -1;
    clearAutoNext();
    clearTimeout(state.repositionTimer);
    hideGuides();
    if (byId("raTutorial")) {
      byId("raTutorial").classList.remove("open");
      byId("raTutorial").style.display = "none";
    }
    if (byId("raRobot")) byId("raRobot").style.display = "none";
    if (typeof window.closeSettings === "function") window.closeSettings();
    if (typeof window.switchView === "function") {
      const btn = q('#rcTopNav button[onclick*="view-joystick"]');
      try { window.switchView("view-joystick", btn); } catch (err) {}
    }
    markDone();
  }

  function nextStep() {
    if (!state.active) return;
    if (state.stepIndex >= STEPS.length - 1) {
      closeTutorial();
      return;
    }
    state.stepIndex += 1;
    renderStep();
  }

  function prevStep() {
    if (!state.active || state.stepIndex <= 0) return;
    state.stepIndex -= 1;
    renderStep();
  }

  function watchConnectedState() {
    if (state.statusObserver) return;
    const statusDot = byId("statusDot");
    if (!statusDot || !window.MutationObserver) return;

    state.statusObserver = new MutationObserver(() => {
      if (!state.active) return;
      if (statusDot.classList.contains("connected")) {
        state.stepIndex = STEPS.length - 1;
        state.enteredStep = -1;
        renderStep();
      }
    });

    state.statusObserver.observe(statusDot, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }

  function patchBtModalOpen() {
    if (typeof window.openBtModal !== "function" || window.openBtModal.__btTourPatched) return;

    const original = window.openBtModal;
    const wrapped = function () {
      const result = original.apply(this, arguments);
      setTimeout(scheduleReposition, 50);
      return result;
    };

    wrapped.__btTourPatched = true;
    window.openBtModal = wrapped;
  }

  function boot() {
    ensureDom();
    watchConnectedState();
    patchBtModalOpen();

    window.startBtTutorial = () => startTutorial(true);

    setTimeout(() => {
      if (!isDone()) startTutorial(false);
    }, 1400);
  }

  window.addEventListener("resize", scheduleReposition);
  window.addEventListener("scroll", scheduleReposition, true);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
