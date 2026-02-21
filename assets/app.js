const CONFIG = {
  brand: "The Store Flight",
  email: "thestoresarlau@gmail.com",
  whatsappNumber: "212627201720",
  currency: "EUR",
  depositAmount: 20,
  paypalClientId: "AfUrubsCvRdT7fWJPaNImjSdiW0rKpxIvLO7Js8fwFYJK6tpZYDyqcUUY2u1E6ckodmgBEoy0OVSlzYU",
  backendUrl: "http://localhost:5000" // remplace par ton lien Render
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

function setActiveNav(){
  const p = (location.pathname.split("/").pop() || "index.html").toLowerCase();
  $$(".menu a").forEach(a=>{
    if((a.getAttribute("href")||"").toLowerCase() === p) a.classList.add("active");
  });
}

function formatMsg(d){
  const lines = [
    `✅ Nouvelle demande - ${CONFIG.brand}`,
    `Service: ${d.service || "-"}`,
    `Nom: ${d.fullname || "-"}`,
    `Téléphone: ${d.phone || "-"}`,
    `Email: ${d.email || "-"}`,
    `Départ: ${d.from || "-"}`,
    `Destination/Ville: ${d.to || d.city || "-"}`,
    `Date 1: ${d.date1 || "-"}`,
    `Date 2: ${d.date2 || "-"}`,
    `Passagers: ${d.pax || "-"}`,
    `Détails: ${d.notes || "-"}`
  ];
  return encodeURIComponent(lines.join("\n"));
}

function goWhatsApp(d){
  window.open(`https://wa.me/${CONFIG.whatsappNumber}?text=${formatMsg(d)}`, "_blank");
}

function saveReq(d){
  localStorage.setItem("tsf_last_request", JSON.stringify(d));
}

document.addEventListener("DOMContentLoaded", ()=>{
  setActiveNav();

  // WhatsApp floating button
  const fab = $("#waFab");
  if(fab){
    fab.addEventListener("click", ()=>{
      const last = JSON.parse(localStorage.getItem("tsf_last_request") || "{}");
      goWhatsApp(Object.keys(last).length ? last : { service:"Info", notes:"Bonjour, j’ai besoin d’informations." });
    });
  }

  // Booking form
  const form = $("#bookingForm");
  if(form){
    const sel = form.querySelector("[name='service']");
    const blocks = $$("[data-block]");
    const apply = ()=>{
      const v = sel.value;
      blocks.forEach(b => b.style.display = "none");
      $$(`[data-block~='${v}']`).forEach(b => b.style.display = "block");
    };
    sel.addEventListener("change", apply); apply();

    form.addEventListener("submit",(e)=>{
      e.preventDefault();
      const d = Object.fromEntries(new FormData(form).entries());
      Object.keys(d).forEach(k => { if(String(d[k]).trim()==="") delete d[k]; });
      saveReq(d);
      location.href="paiement.html";
    });

    const waQuick = $("#waQuick");
    if(waQuick){
      waQuick.addEventListener("click", ()=>{
        const d = Object.fromEntries(new FormData(form).entries());
        goWhatsApp(d);
      });
    }
  }
});
