(function () {
  const FACE_FOR_MOOD = {
    normal: "normal",
    happy: "happy",
    angry: "angry",
    shocked: "shocked",
    sleepy: "sleepy",
    curious: "curious",
    sad: "sad",
    dead: "dead",
  };

  const BASE_SIZE = 94;
  const BASE_FACE_W = 36;
  const BASE_FACE_H = 24;

  const LINES = {
    hello_connected: ["Я тут. Погнали?", "Є контакт. Можемо їхати."],
    hello_disconnected: ["Я тут. Підключай машинку.", "Я на зв'язку. Давай BT."],
    speed_max: ["Надто швидко.", "Обережно!", "Йой, ракета..."],
    speed_low: ["Тихесенько...", "Ледь котимось.", "Спокійний режим."],
    zero_idle: ["Заснув?", "Стоїмо?", "Поїхали?"],
    gyro_angry: ["#@!", "%%%", "ЕЙ!", "Акуратніше!"],
    bt_missing: ["Я не бачу машинку.", "Спочатку підключення."],
    bt_connected: ["Є контакт.", "Погнали.", "BT в нормі."],
    compile_error: ["Упс...", "Я заплутався.", "Щось не так."],
    command_ok: ["Ок.", "Прийнято.", "Є.", "Поїхали."],
    idle_connected: ["Я тут.", "Можемо їхати.", "Чекаю команду."],
    settings_open: ["Тільки нічого не зламай :)", "Обережно з тумблерами :)"],
    tuning_open: ["Тільки не перекрути мотори.", "Головне без магії в налаштуваннях."],
    gyro_on: ["Гіроскоп on.", "Нахиляй обережно."],
    gyro_off: ["Ручний режим.", "Повернулись до джойстика."],
    battery_device_low: ["Я втомився...", "Заряди мене."],
    battery_device_critical: ["Вмираю!", "5%... прощавай."],
    battery_robot_low: ["Машинка теж втомилась.", "Заряд у машинки низький."],
    battery_robot_critical: ["Машинка майже здалась.", "Акум на нулі."],
    tap_confident: [
      "Я краще за GPS.",
      "Знаю, знаю.",
      "Очевидно.",
      "Як завжди я.",
      "Хто молодець? Я молодець.",
      "Геній на зв'язку.",
      "Не дякуй.",
      "Я все бачу.",
      "Так, я красивий.",
      "Я тут головний... майже.",
      "План є?",
      "Погнали вже.",
      "Я не декор."
    ],
    tap_annoyed: [
      "Знову?",
      "Що цього разу?",
      "Серйозно?",
      "Я зайнятий. Майже.",
      "Дай подумати... ні.",
      "Навіщо?",
      "Я не кнопка. Хоча...",
      "Не тицяй без причини.",
      "Я працюю взагалі-то.",
      "Не нервуй мене.",
      "Ще раз натиснеш?",
      "Я образився. Майже."
    ],
    tap_playful: [
      "Тицьни по мені.",
      "Натисни на мене.",
      "Біп.",
      "Тут.",
      "Готовий до всього.",
      "Чекав тебе.",
      "Майже злякався.",
      "Це я.",
      "Жив-здоровий.",
      "Ніяких питань.",
      "О, знову ти.",
      "Командуй.",
      "На зв'язку.",
      "Що?",
      "Ну?",
      "Тиць.",
      "Ти мене покликав?"
    ],
    tap_worker: [
      "Обробляю твій клік...",
      "Зафіксовано.",
      "Помилок не знайдено. Поки.",
      "Система в нормі.",
      "Все під контролем. Здається.",
      "Розрахунки завершено. Їдемо?",
      "Слухаю уважно.",
      "Готовий.",
      "Слухаю."
    ],
    tap_drama: [
      "Знову проігнорований.",
      "Я чекав весь день.",
      "Нарешті.",
      "Думав, забув про мене.",
      "Живу заради цього моменту.",
      "Аж зворушився.",
      "Без паніки."
    ],
  };

  const storageKey = "rbBuddyPosV1";
  const seenKey = "rbBuddySeenV1";
  const state = {
    mood: "normal",
    bubbleTimer: 0,
    cooldowns: Object.create(null),
    lastLineByGroup: Object.create(null),
    dragging: false,
    dragOffsetX: 0,
    dragOffsetY: 0,
    dragStartClientX: 0,
    dragStartClientY: 0,
    dragStartedAt: 0,
    x: 18,
    y: 90,
    lastMoveAt: Date.now(),
    connected: false,
    speed: 100,
    gyro: false,
    tuningOpen: false,
    lastOrientationX: null,
    lastOrientationY: null,
    lastShakeAt: 0,
    lastCommandPraiseAt: 0,
    lastZeroPhraseAt: 0,
    robotBatteryBucket: "",
    deviceBatteryBucket: "",
    scale: 1,
    idleSadActive: false,
    highSpeedActive: false,
    tapLockUntil: 0,
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function pickLine(group) {
    const lines = LINES[group];
    if (!Array.isArray(lines) || !lines.length) return "";
    if (lines.length === 1) return lines[0];

    let next = lines[Math.floor(Math.random() * lines.length)];
    if (lines.length > 1 && state.lastLineByGroup[group] === next) {
      next = lines[(lines.indexOf(next) + 1) % lines.length];
    }
    state.lastLineByGroup[group] = next;
    return next;
  }

  function getJoystickVisible() {
    const el = byId("view-joystick");
    return !!el && !el.classList.contains("hidden");
  }

  function getTutorialVisible() {
    const tour = byId("raTutorial");
    return !!tour && tour.classList.contains("open");
  }

  function isBuddyEnabled() {
    return !window._settings || window._settings.buddyEnabled !== false;
  }

  function ensureShell() {
    if (byId("rbBuddyShell")) return byId("rbBuddyShell");

    const shell = document.createElement("div");
    shell.id = "rbBuddyShell";
    shell.className = "bubble-right hidden";
    shell.innerHTML =
      '<div id="rbBuddyBubble"><span id="rbBuddyBubbleText"></span></div>' +
      '<div id="rbBuddy" class="mood-normal" data-has-lottie="0">' +
      '<div id="rbBuddyLottie"></div>' +
      '<div id="rbBuddyFallback">🤖</div>' +
      '<div id="rbBuddyFace" data-face="normal"></div>' +
      "</div>";

    document.body.appendChild(shell);
    return shell;
  }

  function setFace(mood) {
    const face = byId("rbBuddyFace");
    if (!face) return;
    face.dataset.face = FACE_FOR_MOOD[mood] || "normal";
  }

  function setMood(mood) {
    const robot = byId("rbBuddy");
    if (!robot) return;
    state.mood = mood;
    robot.classList.remove("mood-normal", "mood-happy", "mood-angry", "mood-shocked", "mood-sleepy", "mood-curious", "mood-sad", "mood-dead");
    if (mood && mood !== "normal") robot.classList.add("mood-" + mood);
    setFace(mood);
  }

  function triggerPose(name) {
    const robot = byId("rbBuddy");
    if (!robot) return;
    robot.classList.remove("pose-left", "pose-right", "pose-hype", "pose-shrug");
    if (!name) return;
    robot.classList.add(name);
    window.clearTimeout(robot._poseTimer);
    robot._poseTimer = window.setTimeout(() => {
      robot.classList.remove("pose-left", "pose-right", "pose-hype", "pose-shrug");
    }, 620);
  }

  function getAmbientMood() {
    if (state.robotBatteryBucket === "critical" || state.deviceBatteryBucket === "critical") return "dead";
    if (state.idleSadActive) return "sad";
    if (state.highSpeedActive) return "shocked";
    return "normal";
  }

  function applyAmbientMood() {
    setMood(getAmbientMood());
  }

  function applyScale(scale) {
    const shell = byId("rbBuddyShell");
    const face = byId("rbBuddyFace");
    const next = Number(scale);
    state.scale = Number.isFinite(next) && next > 0 ? next : 1;
    if (shell) {
      shell.style.setProperty("--rbb-scale", String(state.scale));
      shell.style.width = BASE_SIZE * state.scale + "px";
      shell.style.height = BASE_SIZE * state.scale + "px";
    }
    if (face) {
      face.style.width = BASE_FACE_W * state.scale + "px";
      face.style.height = BASE_FACE_H * state.scale + "px";
      face.style.top = Math.round(20 * state.scale) + "px";
    }
    applyPosition();
  }

  function applySettings(settings) {
    const nextScale = settings && settings.buddyScale != null ? settings.buddyScale : 1;
    applyScale(nextScale);
    if (!isBuddyEnabled()) hideBubble();
    updateVisibility();
  }

  function applyBubblePlacement() {
    const shell = byId("rbBuddyShell");
    if (!shell) return;
    shell.classList.remove("bubble-left", "bubble-right", "bubble-bottom");

    const needsLeft = state.x > window.innerWidth - 240;
    const needsBottom = state.y < 100;

    shell.classList.add(needsLeft ? "bubble-left" : "bubble-right");
    if (needsBottom) shell.classList.add("bubble-bottom");
  }

  function applyPosition() {
    const shell = byId("rbBuddyShell");
    if (!shell) return;

    const maxX = Math.max(8, window.innerWidth - shell.offsetWidth - 8);
    const maxY = Math.max(8, window.innerHeight - shell.offsetHeight - 8);
    state.x = clamp(state.x, 8, maxX);
    state.y = clamp(state.y, 8, maxY);

    shell.style.left = state.x + "px";
    shell.style.top = state.y + "px";
    applyBubblePlacement();
  }

  function savePosition() {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ x: state.x, y: state.y }));
    } catch (err) {}
  }

  function loadPosition() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
        state.x = saved.x;
        state.y = saved.y;
        return;
      }
    } catch (err) {}

    state.x = 16;
    state.y = Math.max(86, window.innerHeight - 150);
  }

  function bump(classes) {
    const robot = byId("rbBuddy");
    if (!robot) return;
    robot.classList.add("bump");
    if (classes) robot.classList.add(classes);
    window.clearTimeout(robot._bumpTimer);
    robot._bumpTimer = window.setTimeout(() => {
      robot.classList.remove("bump");
      if (classes) robot.classList.remove(classes);
    }, classes === "shake" ? 920 : 280);
  }

  function hideBubble() {
    const bubble = byId("rbBuddyBubble");
    if (!bubble) return;
    bubble.classList.remove("show", "mood-happy", "mood-angry", "mood-shocked", "mood-sleepy", "mood-curious", "mood-sad", "mood-dead");
  }

  function speak(text, mood, options) {
    if (!isBuddyEnabled()) return;

    const opts = options || {};
    const now = Date.now();
    const key = opts.key || text;
    const minGap = typeof opts.minGap === "number" ? opts.minGap : 2400;

    if (key && state.cooldowns[key] && now - state.cooldowns[key] < minGap) return;
    state.cooldowns[key] = now;

    const shell = byId("rbBuddyShell");
    const bubble = byId("rbBuddyBubble");
    const bubbleText = byId("rbBuddyBubbleText");
    if (!shell || !bubble || !bubbleText) return;

    setMood(mood || "normal");
    bubbleText.textContent = text;
    bubble.classList.remove("mood-happy", "mood-angry", "mood-shocked", "mood-sleepy", "mood-curious", "mood-sad", "mood-dead");
    if (mood && mood !== "normal") bubble.classList.add("mood-" + mood);
    bubble.classList.add("show");
    applyBubblePlacement();
    bump(mood === "angry" ? "shake" : "");
    if (opts.pose) triggerPose(opts.pose);

    window.clearTimeout(state.bubbleTimer);
    if (!opts.sticky) {
      state.bubbleTimer = window.setTimeout(() => {
        hideBubble();
        applyAmbientMood();
      }, opts.duration || 2500);
    }
  }

  function updateVisibility() {
    const shell = byId("rbBuddyShell");
    if (!shell) return;
    const shouldShow = isBuddyEnabled() && getJoystickVisible() && !getTutorialVisible();
    shell.classList.toggle("hidden", !shouldShow);
    if (!shouldShow) hideBubble();
  }

  function connectAnimation() {
    const robot = byId("rbBuddy");
    const holder = byId("rbBuddyLottie");
    if (!robot || !holder || !window.lottie || robot.dataset.hasLottie === "1") return;

    try {
      window.lottie.loadAnimation({
        container: holder,
        renderer: "svg",
        loop: true,
        autoplay: true,
        path: "assets/bt-tour-robot/robot-buddy.json",
        assetsPath: "assets/bt-tour-robot/",
      });
      robot.dataset.hasLottie = "1";
    } catch (err) {}
  }

  function syncBtState(notify) {
    const connected = !!byId("statusDot") && byId("statusDot").classList.contains("connected");
    if (connected === state.connected && notify) return;
    state.connected = connected;

    if (notify) {
      if (connected) {
        speak(pickLine("bt_connected"), "happy", { key: "bt-on", minGap: 1600 });
      } else {
        speak(pickLine("bt_missing"), "curious", { key: "bt-off", minGap: 1600 });
      }
    }
  }

  function syncGyroState(notify) {
    const btn = byId("gyroBtn");
    const enabled = !!btn && (btn.dataset.active === "1" || btn.getAttribute("aria-pressed") === "true");
    if (enabled === state.gyro && notify) return;
    state.gyro = enabled;

    if (notify) {
      if (enabled) speak(pickLine("gyro_on"), "curious", { key: "gyro-on", minGap: 1800 });
      else speak(pickLine("gyro_off"), "normal", { key: "gyro-off", minGap: 1800 });
    }
  }

  function syncSpeedState(notify) {
    const slider = byId("speedSlider");
    if (!slider) return;
    const value = Number(slider.value || 0);
    state.speed = value;

    if (!notify) return;

    if (value >= 100) {
      speak(pickLine("speed_max"), "shocked", { key: "speed-100", minGap: 4200 });
    } else if (value <= 20) {
      speak(pickLine("speed_low"), "sleepy", { key: "speed-low", minGap: 5200 });
    }
  }

  function readDriveState() {
    const left = Number((byId("motorLDisplay") || {}).textContent || 0);
    const right = Number((byId("motorRDisplay") || {}).textContent || 0);
    const maxPower = Math.max(Math.abs(left), Math.abs(right));
    state.highSpeedActive = state.speed >= 100 && maxPower >= 92;

    if (maxPower > 4) {
      state.lastMoveAt = Date.now();
    }

    if (state.speed >= 100 && maxPower >= 92) {
      speak(pickLine("speed_max"), "shocked", { key: "drive-fast", minGap: 5200 });
    }

    if (state.connected && maxPower >= 35 && Date.now() - state.lastCommandPraiseAt > 7000) {
      state.lastCommandPraiseAt = Date.now();
      speak(pickLine("command_ok"), "happy", { key: "command-ok", minGap: 5000, duration: 1800 });
    }

    if (maxPower === 0 && Date.now() - state.lastMoveAt > 7000 && Date.now() - state.lastZeroPhraseAt > 10000) {
      state.lastZeroPhraseAt = Date.now();
      speak(pickLine("zero_idle"), state.connected ? "sleepy" : "curious", { key: "zero-idle", minGap: 9000 });
    }
  }

  function bindDrag() {
    const robot = byId("rbBuddy");
    if (!robot) return;

    robot.addEventListener("pointerdown", (event) => {
      state.dragging = true;
      state.dragOffsetX = event.clientX - state.x;
      state.dragOffsetY = event.clientY - state.y;
      state.dragStartClientX = event.clientX;
      state.dragStartClientY = event.clientY;
      state.dragStartedAt = Date.now();
      robot.classList.add("dragging");
      robot.setPointerCapture(event.pointerId);
    });

    window.addEventListener("pointermove", (event) => {
      if (!state.dragging) return;
      state.x = event.clientX - state.dragOffsetX;
      state.y = event.clientY - state.dragOffsetY;
      applyPosition();
    });

    function endDrag(event) {
      if (!state.dragging) return;
      const moved = Math.hypot(
        ((event && typeof event.clientX === "number") ? event.clientX : state.dragStartClientX) - state.dragStartClientX,
        ((event && typeof event.clientY === "number") ? event.clientY : state.dragStartClientY) - state.dragStartClientY
      );
      const wasTap = moved < 10 && Date.now() - state.dragStartedAt < 260;
      state.dragging = false;
      robot.classList.remove("dragging");
      savePosition();
      if (wasTap) {
        const now = Date.now();
        if (now > state.tapLockUntil) {
          state.tapLockUntil = now + 700;
          onRobotTap();
        }
      }
    }

    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
  }

  function onRobotTap() {
    const groups = [
      { key: "tap_confident", mood: "happy", poses: ["pose-left", "pose-hype"] },
      { key: "tap_annoyed", mood: "angry", poses: ["pose-right", "pose-shrug"] },
      { key: "tap_playful", mood: "curious", poses: ["pose-left", "pose-right", "pose-hype"] },
      { key: "tap_worker", mood: "normal", poses: ["pose-right", "pose-shrug"] },
      { key: "tap_drama", mood: "sad", poses: ["pose-shrug", "pose-left"] },
    ];

    const pickGroup = groups[Math.floor(Math.random() * groups.length)];
    const pose = pickGroup.poses[Math.floor(Math.random() * pickGroup.poses.length)];
    speak(pickLine(pickGroup.key), pickGroup.mood, {
      key: "tap-talk",
      minGap: 500,
      duration: 2200,
      pose,
    });
  }

  function watchDom() {
    const statusDot = byId("statusDot");
    if (statusDot && window.MutationObserver) {
      new MutationObserver(() => syncBtState(true)).observe(statusDot, {
        attributes: true,
        attributeFilter: ["class"],
      });
    }

    const gyroBtn = byId("gyroBtn");
    if (gyroBtn && window.MutationObserver) {
      new MutationObserver(() => syncGyroState(true)).observe(gyroBtn, {
        attributes: true,
        attributeFilter: ["data-active", "aria-pressed", "class"],
      });
    }

    const joystickView = byId("view-joystick");
    if (joystickView && window.MutationObserver) {
      new MutationObserver(updateVisibility).observe(joystickView, {
        attributes: true,
        attributeFilter: ["class"],
      });
    }

    const tutorial = byId("raTutorial");
    if (tutorial && window.MutationObserver) {
      new MutationObserver(updateVisibility).observe(tutorial, {
        attributes: true,
        attributeFilter: ["class", "style"],
      });
    }

    const tuningModal = byId("tuningModal");
    if (tuningModal && window.MutationObserver) {
      new MutationObserver(() => {
        const open = !tuningModal.classList.contains("hidden");
        if (open !== state.tuningOpen) {
          state.tuningOpen = open;
          if (open) speak(pickLine("tuning_open"), "curious", { key: "tuning-open", minGap: 5000 });
        }
      }).observe(tuningModal, {
        attributes: true,
        attributeFilter: ["class"],
      });
    }

    const settingsModal = byId("settingsModal");
    if (settingsModal && window.MutationObserver) {
      new MutationObserver(() => {
        const open = settingsModal.style.display !== "none";
        if (open) speak(pickLine("settings_open"), "curious", { key: "settings-open", minGap: 5000 });
      }).observe(settingsModal, {
        attributes: true,
        attributeFilter: ["style"],
      });
    }
  }

  function watchInputs() {
    const slider = byId("speedSlider");
    if (slider) {
      slider.addEventListener("input", () => syncSpeedState(true));
    }
  }

  function watchOrientation() {
    window.addEventListener(
      "deviceorientation",
      (event) => {
        if (!state.gyro) return;
        if (typeof event.gamma !== "number" || typeof event.beta !== "number") return;

        if (state.lastOrientationX == null || state.lastOrientationY == null) {
          state.lastOrientationX = event.gamma;
          state.lastOrientationY = event.beta;
          return;
        }

        const dx = Math.abs(event.gamma - state.lastOrientationX);
        const dy = Math.abs(event.beta - state.lastOrientationY);
        state.lastOrientationX = event.gamma;
        state.lastOrientationY = event.beta;

        const burst = dx + dy;
        const now = Date.now();
        if (burst > 26 && now - state.lastShakeAt > 1500) {
          state.lastShakeAt = now;
          speak(pickLine("gyro_angry"), "angry", { key: "gyro-shake", minGap: 1500 });
        }
      },
      { passive: true }
    );
  }

  function evaluateRobotBattery() {
    const pct = Number(window._batPct);
    if (!Number.isFinite(pct)) return;

    let bucket = "";
    if (pct <= 5) bucket = "critical";
    else if (pct <= 20) bucket = "low";

    if (bucket === state.robotBatteryBucket) return;
    state.robotBatteryBucket = bucket;

    if (bucket === "critical") {
      speak(pickLine("battery_robot_critical"), "dead", { key: "robot-bat-critical", minGap: 12000, duration: 3400 });
    } else if (bucket === "low") {
      speak(pickLine("battery_robot_low"), "sleepy", { key: "robot-bat-low", minGap: 12000, duration: 3000 });
    }
  }

  function watchBattery() {
    window.setInterval(evaluateRobotBattery, 4000);

    if (navigator.getBattery) {
      navigator.getBattery().then((battery) => {
        const check = () => {
          if (battery.charging) {
            state.deviceBatteryBucket = "";
            return;
          }

          const pct = Math.round((battery.level || 0) * 100);
          let bucket = "";
          if (pct <= 5) bucket = "critical";
          else if (pct <= 15) bucket = "low";

          if (bucket === state.deviceBatteryBucket) return;
          state.deviceBatteryBucket = bucket;

          if (bucket === "critical") {
            speak(pickLine("battery_device_critical"), "dead", { key: "device-bat-critical", minGap: 15000, duration: 3400 });
          } else if (bucket === "low") {
            speak(pickLine("battery_device_low"), "sleepy", { key: "device-bat-low", minGap: 15000, duration: 3000 });
          }
        };

        check();
        battery.addEventListener("levelchange", check);
        battery.addEventListener("chargingchange", check);
      }).catch(() => {});
    }
  }

  function hookLogsAndActions() {
    if (typeof window.log === "function" && !window.log.__rbBuddyWrapped) {
      const originalLog = window.log;
      const wrappedLog = function (msg, type) {
        const result = originalLog.apply(this, arguments);
        const text = String(msg || "");
        const lower = text.toLowerCase();

        if (
          lower.includes("немає блоків для компіляції") ||
          lower.includes("js generator not ready") ||
          lower.includes("error:") ||
          lower.includes("⚠️")
        ) {
          speak(pickLine("compile_error"), "angry", { key: "compile-error", minGap: 4000 });
        } else if (
          lower.includes("готово!") ||
          lower.includes("program started")
        ) {
          speak(pickLine("command_ok"), "happy", { key: "program-ok", minGap: 5000, duration: 1800 });
        }

        return result;
      };
      wrappedLog.__rbBuddyWrapped = true;
      window.log = wrappedLog;
    }

    if (typeof window.sendDrivePacket === "function" && !window.sendDrivePacket.__rbBuddyWrapped) {
      const originalSendDrivePacket = window.sendDrivePacket;
      const wrappedSendDrivePacket = async function (m1, m2, m3, m4) {
        const result = await originalSendDrivePacket.apply(this, arguments);
        const maxPower = Math.max(Math.abs(Number(m1) || 0), Math.abs(Number(m2) || 0), Math.abs(Number(m3) || 0), Math.abs(Number(m4) || 0));
        if (state.connected && maxPower >= 35 && Date.now() - state.lastCommandPraiseAt > 7000) {
          state.lastCommandPraiseAt = Date.now();
          speak(pickLine("command_ok"), "happy", { key: "send-ok", minGap: 5000, duration: 1800 });
        }
        if (maxPower > 4 && state.idleSadActive) {
          state.idleSadActive = false;
          applyAmbientMood();
        }
        return result;
      };
      wrappedSendDrivePacket.__rbBuddyWrapped = true;
      window.sendDrivePacket = wrappedSendDrivePacket;
    }

    window.addEventListener("error", () => {
      speak(pickLine("compile_error"), "angry", { key: "window-error", minGap: 4000 });
    });

    window.addEventListener("unhandledrejection", () => {
      speak(pickLine("compile_error"), "angry", { key: "promise-error", minGap: 4000 });
    });
  }

  function startLoops() {
    window.setInterval(() => {
      updateVisibility();
      readDriveState();

      const idleFor = Date.now() - state.lastMoveAt;
      if (getJoystickVisible() && !getTutorialVisible() && idleFor > 22000) {
        if (!state.idleSadActive) {
          state.idleSadActive = true;
          hideBubble();
          applyAmbientMood();
        }
      } else if (state.idleSadActive && idleFor < 12000) {
        state.idleSadActive = false;
        applyAmbientMood();
      }

      applyAmbientMood();

      if (
        getJoystickVisible() &&
        !getTutorialVisible() &&
        idleFor > 12000 &&
        !state.idleSadActive
      ) {
        speak(state.connected ? pickLine("idle_connected") : pickLine("bt_missing"), state.connected ? "sleepy" : "curious", {
          key: "idle",
          minGap: 15000,
        });
      }
    }, 1600);
  }

  function boot() {
    ensureShell();
    loadPosition();
    applySettings(window._settings || {});
    applyPosition();
    connectAnimation();
    bindDrag();
    watchDom();
    watchInputs();
    watchOrientation();
    watchBattery();
    hookLogsAndActions();
    syncBtState(false);
    syncGyroState(false);
    syncSpeedState(false);
    updateVisibility();
    startLoops();

    window.addEventListener("resize", applyPosition);

    window.setTimeout(() => {
      updateVisibility();
      if (getTutorialVisible()) return;
      const seen = localStorage.getItem(seenKey);
      if (!seen) {
        speak(state.connected ? pickLine("hello_connected") : pickLine("hello_disconnected"), state.connected ? "happy" : "curious", {
          key: "hello",
          minGap: 999999,
          duration: 3200,
        });
        try { localStorage.setItem(seenKey, "1"); } catch (err) {}
      }
    }, 1200);

    window.RoboBuddy = {
      applySettings,
      setScale: applyScale,
      speak,
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
