// assets/app.js
(() => {
  // =========================
  // WhatsApp floating button
  // =========================
  const waFab = document.getElementById("waFab");
  if (waFab) {
    const phone = "212627201720"; // change if needed (no +)
    const msg = encodeURIComponent("Bonjour The Store Flight, je veux réserver un service.");
    waFab.href = `https://wa.me/${phone}?text=${msg}`;
    waFab.target = "_blank";
    waFab.rel = "noopener";
  }

  // =========================
  // Services cards: make clickable
  // Works on index.html + services.html
  // =========================
  const cards = document.querySelectorAll(".cards .card");
  if (!cards || cards.length === 0) return;

  // Detect service type from card text
  function detectServiceType(text) {
    const t = (text || "").toLowerCase();

    if (t.includes("billet") || t.includes("vol") || t.includes("avion") || t.includes("flight")) return "vol";
    if (t.includes("hôtel") || t.includes("hotel")) return "hotel";
    if (t.includes("visa") && !t.includes("evisa")) return "visa";
    if (t.includes("assurance")) return "assurance";
    if (t.includes("evisa")) return "evisa";
    if (t.includes("tour") || t.includes("voyage") || t.includes("organisé") || t.includes("organise")) return "tour";

    return null;
  }

  function makeCardClickable(card) {
    const service = detectServiceType(card.innerText);
    if (!service) return;

    // Make it look clickable
    card.style.cursor = "pointer";

    // Accessibility: allow keyboard
    card.setAttribute("role", "link");
    card.setAttribute("tabindex", "0");
    card.setAttribute("aria-label", `Ouvrir le formulaire: ${service}`);

    const go = () => {
      window.location.href = `reserver.html?service=${encodeURIComponent(service)}`;
    };

    card.addEventListener("click", (e) => {
      // Prevent weird selections
      e.preventDefault?.();
      go();
    });

    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        go();
      }
    });
  }

  cards.forEach(makeCardClickable);
})();
