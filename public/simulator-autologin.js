(function () {
  function shouldRun() {
    return String(window.location.href).indexOf("simulatorAutoLogin=1") !== -1;
  }

  function runAutoLogin() {
    if (!shouldRun()) return;
    if (window.__jpycSimulatorAutoLoginStarted) return;
    window.__jpycSimulatorAutoLoginStarted = true;
    var terminalCode = document.getElementById("terminalCode");
    var staffPin = document.getElementById("staffPin");
    var staffPinConfirm = document.getElementById("staffPinConfirm");
    var staffName = document.getElementById("staffNameInput");
    if (terminalCode) terminalCode.value = "TERM-001";
    if (staffPin) staffPin.value = "1234";
    if (staffPinConfirm) staffPinConfirm.value = "";
    if (staffName) staffName.value = "";
    if (typeof window.handleLogin === "function") {
      void window.handleLogin();
      return;
    }
    void fetch("/api/v1/terminal-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ terminalCode: "TERM-001", staffPin: "1234" })
    }).then(function (res) {
      if (!res.ok) throw new Error("login failed");
      document.body.classList.add("is-terminal-logged-in");
      var loginStart = document.getElementById("loginStartPanel");
      var tabNav = document.getElementById("terminalTabNav");
      var workspace = document.getElementById("terminalWorkspace");
      if (loginStart) loginStart.classList.add("hidden");
      if (tabNav) tabNav.classList.remove("hidden");
      if (workspace) workspace.classList.remove("hidden");
    }).catch(function () {});
  }

  window.addEventListener("load", function () {
    window.setTimeout(runAutoLogin, 250);
    window.setTimeout(runAutoLogin, 1000);
  }, { once: true });
  window.setTimeout(runAutoLogin, 100);
  window.setTimeout(runAutoLogin, 700);
})();
