const SITE = "https://ici.radio-canada.ca";
// `hour` is when the show airs; the time in the episode data is not reliable.
const SHOWS = [
  { name: "Téléjournal midi", path: "/tele/le-telejournal-midi/site/episodes", hour: 12, color: "#0277bd" },
  { name: "Téléjournal 18 h", path: "/tele/le-telejournal-18h/site/episodes", hour: 18, color: "#d50000" },
];
const FIRST_HOUR = 6, LAST_HOUR = 22;
const TZ = "America/Toronto"; // Montréal

async function getPage(path) {
  const res = await fetch(SITE + path);
  if (!res.ok) throw new Error(`HTTP ${res.status} : ${path}`);
  return res.text();
}

// The pages embed their data as `window._rcState_ = {...}`.
function readState(html) {
  const start = html.indexOf("window._rcState_");
  if (start < 0) throw new Error("window._rcState_ introuvable");
  const eq = html.indexOf("=", start) + 1;
  const end = html.indexOf("</script>", eq);
  return JSON.parse(html.slice(eq, end).trim().replace(/;$/, ""));
}

async function getEpisodes(show) {
  const state = readState(await getPage(show.path));
  // Episodes whose video isn't available are listed too, with `duration: null`.
  return state.pages.pages[show.path].data.lineup.items
    .filter((ep) => ep.isMediaPlayable && ep.duration)
    .map((ep) => ({ ...ep, show }));
}

async function getMediaId(episodeUrl) {
  const match = (await getPage(episodeUrl)).match(/"mediaId":"(\d+)"/);
  if (!match) throw new Error("Vidéo introuvable");
  return match[1];
}

// The validation API caps the stream at 480p with `aws.manifestfilter`; without
// it the manifest also offers 720p and 1080p. Other parameters are kept as is.
function withoutBitrateCap(url) {
  const q = url.indexOf("?");
  if (q < 0) return url;
  const params = url.slice(q + 1).split("&").filter((p) => p && !p.startsWith("aws.manifestfilter="));
  return url.slice(0, q) + (params.length ? "?" + params.join("&") : "");
}

// The validation API has no CORS headers, but supports JSONP.
let jsonpCount = 0;
function getStreamUrl(mediaId) {
  return new Promise((resolve, reject) => {
    const cb = "rc_" + ++jsonpCount;
    const s = document.createElement("script");
    const cleanup = () => { clearTimeout(timer); delete window[cb]; s.remove(); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("Délai dépassé")); }, 15000);
    window[cb] = (data) => { cleanup();
      data.url ? resolve(withoutBitrateCap(data.url)) : reject(new Error(data.message || "Pas de flux")); };
    s.onerror = () => { cleanup(); reject(new Error("Erreur réseau")); };
    s.src = "https://services.radio-canada.ca/media/validation/v2/?appCode=medianet&idMedia=" + mediaId +
            "&output=jsonp&callback=" + cb + "&tech=hls&deviceType=ipad&connectionType=hd&multibitrate=true";
    document.head.appendChild(s);
  });
}

// Episode dates look like "2026-09-23T12:00:00.000Z" but are Montréal time,
// so only the calendar date is used, and the days shown are Montréal's.
function lastDays(count) {
  const now = Object.fromEntries(
    new Intl.DateTimeFormat("en", { timeZone: TZ, year: "numeric", month: "numeric", day: "numeric" })
      .formatToParts(new Date()).map((p) => [p.type, +p.value]));
  // Midnight UTC of each day, so reading them in UTC gives Montréal's dates.
  return [...Array(count)].map((_, i) => new Date(Date.UTC(now.year, now.month - 1, now.day - count + 1 + i)));
}
const ymd = (d) => d.toISOString().slice(0, 10);

let episodes = [], dayCount = 1;

function render() {
  const days = lastDays(dayCount);
  const today = ymd(days[days.length - 1]);
  document.querySelector(".body").style.setProperty("--days", dayCount);
  for (const b of document.querySelectorAll("#range button")) b.setAttribute("aria-pressed", +b.dataset.days === dayCount);

  const head = document.getElementById("head");
  head.innerHTML = '<div class="head"></div>' + days.map((d) => `
    <div class="head ${ymd(d) === today ? "today" : ""}">
      <div class="dow">${d.toLocaleDateString("fr-CA", { weekday: "short", timeZone: "UTC" })}</div>
      <div class="num">${d.getUTCDate()}</div>
    </div>`).join("");

  const grid = document.getElementById("grid");
  const hours = [...Array(LAST_HOUR - FIRST_HOUR)].map((_, i) => `<div>${i ? FIRST_HOUR + i + " h" : ""}</div>`).join("");
  grid.innerHTML = `<div class="hours">${hours}</div>`;

  const hourPx = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--hour"));
  for (const d of days) {
    const col = document.createElement("div");
    col.className = "day";
    grid.appendChild(col);
    for (const ep of episodes.filter((e) => e.date.slice(0, 10) === ymd(d))) {
      const minutes = Math.round(ep.duration.seconds / 60);
      const btn = document.createElement("button");
      btn.className = "event";
      btn.style.top = (ep.show.hour - FIRST_HOUR) * hourPx + "px";
      btn.style.height = Math.max(minutes / 60 * hourPx, 22) + "px";
      btn.style.background = ep.show.color;
      btn.innerHTML = `${ep.show.name} <small>${ep.show.hour} h · ${minutes} min</small>`;
      btn.onclick = () => play(ep);
      col.appendChild(btn);
      // Too short for the details on their own line: put everything on one.
      if (btn.scrollHeight > btn.clientHeight) btn.classList.add("short");
    }
  }
  document.querySelector(".body").scrollTop = (11 - FIRST_HOUR) * hourPx;
}

let hls, loadId = 0;
const dialog = document.getElementById("player");
const video = document.getElementById("video");

async function play(ep) {
  const id = ++loadId;
  const fail = (err) => {
    if (id === loadId) document.getElementById("ptitle").textContent = ep.title + " — " + err.message;
  };
  document.getElementById("ptitle").textContent = ep.show.name + " — " + ep.title;
  document.getElementById("plink").href = SITE + ep.url;
  dialog.showModal();
  try {
    const src = await getStreamUrl(await getMediaId(ep.url));
    // The player was closed, or another episode opened, while this one loaded.
    if (id !== loadId || !dialog.open) return;
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.onerror = () => fail(new Error("Lecture impossible"));
      video.src = src;
    } else if (window.Hls?.isSupported()) {
      hls = new Hls();
      hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) fail(new Error("Lecture impossible : " + data.details)); });
      hls.loadSource(src);
      hls.attachMedia(video);
    } else {
      throw new Error("Lecture HLS non prise en charge");
    }
  } catch (err) {
    fail(err);
  }
}

function stop() {
  if (hls) { hls.destroy(); hls = null; }
  video.removeAttribute("src");
  video.load();
}
dialog.addEventListener("close", stop);
document.getElementById("pclose").onclick = () => dialog.close();

document.getElementById("range").onclick = (e) => {
  const count = +e.target.dataset.days;
  if (count) { dayCount = count; render(); }
};
render();

// One show failing to load shouldn't hide the others.
Promise.allSettled(SHOWS.map(getEpisodes)).then((results) => {
  results.forEach((r, i) => { if (r.status === "rejected") console.error(SHOWS[i].name, r.reason); });
  episodes = results.flatMap((r) => r.value || []);
  render();
  const failed = SHOWS.filter((_, i) => results[i].status === "rejected").map((s) => s.name);
  document.getElementById("status").textContent = failed.length ? "Erreur : " + failed.join(", ") : "";
}).catch((err) => {
  console.error(err);
  document.getElementById("status").textContent = "Erreur : " + err.message;
});
