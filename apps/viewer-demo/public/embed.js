(function () {
  var currentScript = document.currentScript;
  if (!currentScript) {
    return;
  }

  var scene = currentScript.getAttribute("data-scene") || "/scenes/demo/scene.manifest.json";
  var title = currentScript.getAttribute("data-title") || "3D walkthrough";
  var height = currentScript.getAttribute("data-height") || "640px";
  var host = currentScript.getAttribute("data-host") || window.location.origin;
  var src = host + "/?scene=" + encodeURIComponent(scene) + "&embed=1";

  var iframe = document.createElement("iframe");
  iframe.title = title;
  iframe.src = src;
  iframe.allow = "fullscreen; autoplay";
  iframe.allowFullscreen = true;
  iframe.style.width = "100%";
  iframe.style.height = height;
  iframe.style.border = "0";
  iframe.style.display = "block";
  iframe.style.background = "#101417";

  currentScript.parentNode.insertBefore(iframe, currentScript.nextSibling);
})();

