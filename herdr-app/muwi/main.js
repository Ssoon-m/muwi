// muwi 그래프 칸 (Herdr 앱 mod).
// AI가 적은 작업 계획과 진행 기록을 `muwi board`로 읽어 그린다. 기록도 세션도 바꾸지 않는다.
//   작업 목록: 급한 순서로 묶는다 (나를 기다림이 위). 계획 없이 일하는 세션도 같이 보여서 Herdr의 Agents 칸을 대신한다
//   그래프: 고른 작업의 계획. 카드와 선의 좌표는 `muwi board`가 ELK로 계산해서 준다. 기록이 바뀌면 전체를 다시 그린다
//   기록: 고른 노드의 기록 (맡은 세션, 걸린 시간, 읽은 skill, 문제 표시) 또는 작업의 기록 (계획이 바뀐 이유)
// 끌어서 옮기고, cmd/ctrl+스크롤로 확대한다. 지금 일어나는 곳(작업 중, 나를 기다림)이 보이게 따라간다.
// 키보드가 있는 터미널이 바뀌면 그 터미널의 세션이 하는 작업으로 바꿔 보여 준다.
import { View, div, svg, image, PathBuilder } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  exec, home, theme, watchFolder, checking, shared, setShared, agents, panes, terminals, focused, updates, run, notify,
  layout as shownLayout, props as blockProps, window as appWindow,
} from "herdr";

const SELECTED = "muwi.selected";
/** 사람이(또는 따라가기가) 작업을 고른 때. 다른 칸이 계획 없는 세션의 빈 화면을 풀 때 본다 */
const PICKED = "muwi.picked";
const PLACE_NAME = { bottom: "아래", top: "위", right: "오른쪽" };
/** 오른쪽 기록 칸의 가장 좁은 너비 */
const DETAIL_MIN = 220;
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const STATE_NAME = { waiting: "나를 기다림", blocked: "막힘", doing: "작업 중", stalled: "멈춤", done: "끝", idle: "노드 사이" };
const STATUS_NAME = { todo: "아직", doing: "작업 중", waiting: "나를 기다림", blocked: "막힘", done: "끝" };
const AGENT_NAME = { working: "세션 작업 중", blocked: "세션이 입력을 기다림", done: "세션이 멈춤", idle: "세션이 멈춤" };
const RUN_NAME = { me: "직접", subagent: "서브에이전트", session: "새 세션" };
/** 세션 상태의 급한 정도 (Herdr의 Agents 칸과 같은 순서) */
const AGENT_RANK = { blocked: 3, working: 2, done: 1, idle: 0 };
/** 세션이 시작될 때 muwi 훅이 터미널에 붙이는 이름표 (그 터미널에서 지금 도는 세션) */
const LABEL_SESSION = "muwi.session";
/** Herdr가 직접 내는 레이아웃. muwi layout은 이걸 복제해서 바꾼다 */
const SHIPPED = ["main", "terminals", "win98"];

/** 에이전트가 제목 앞에 붙이는 상태 글자를 뗀다 (Herdr의 Agents 칸과 같은 규칙) */
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").replace(/^\[ [!.] \] /, "").trim();

/** 프로그램 아이콘 (Herdr의 프로그램 표) */
function programIcon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

/**
 * muwi 명령을 실행한다 (muwi setup이 ~/.local/bin에 넣은 것).
 * Windows에서는 muwi.cmd를 cmd.exe로 실행한다. sh 스크립트는 Windows에서 바로 실행되지 않는다
 */
function runMuwi(args, options) {
  if (appWindow()?.platform === "windows") return exec("cmd.exe", ["/d", "/c", `${home()}\\.local\\bin\\muwi.cmd`, ...args], options);
  return exec(`${home()}/.local/bin/muwi`, args, options);
}

/** 레이아웃 나무에서 id로 칸을 찾는다 */
function findNode(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

/** 레이아웃 나무에 조건에 맞는 칸이 있는가 */
function anyNode(node, match) {
  if (!node || typeof node !== "object") return false;
  if (match(node)) return true;
  return (node.children ?? []).some((child) => anyNode(child, match));
}

function ago(iso, now) {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.round(s / 60)}분 전`;
  if (s < 86400) return `${Math.round(s / 3600)}시간 전`;
  return `${Math.round(s / 86400)}일 전`;
}

/** 걸린 시간: 1h 1m 1s. 진행 중인 노드는 초마다 늘어나므로 반올림하지 않고 버린다 */
function dur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function clock(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** #rrggbb에 투명도(0~1)를 붙인다 */
function tint(c, a) {
  if (typeof c !== "string" || c.length !== 7) return c;
  return c + Math.round(a * 255).toString(16).padStart(2, "0");
}

/** 꺾이는 점들을 둥근 모서리로 잇는다 */
function roundPath(b, pts, r) {
  b = b.move_to(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1], [cx, cy] = pts[i], [nx, ny] = pts[i + 1];
    const d1 = Math.hypot(cx - px, cy - py) || 1, d2 = Math.hypot(nx - cx, ny - cy) || 1;
    const rr = Math.min(r, d1 / 2, d2 / 2);
    b = b.line_to(cx + ((px - cx) / d1) * rr, cy + ((py - cy) / d1) * rr)
      .curve_to(cx + ((nx - cx) / d2) * rr, cy + ((ny - cy) / d2) * rr, cx, cy);
  }
  const [lx, ly] = pts[pts.length - 1];
  return b.line_to(lx, ly);
}

/** 이어 하기 버튼을 누른 뒤 이만큼은 다시 누르지 못하게 한다 (반응이 없어 보여 여러 번 눌러 탭이 여럿 뜨지 않게) */
const OPENING_MS = 3000;
/** Claude 세션 id 모양. 이 모양이면 claude --resume <id>로 그 대화를 다시 열 수 있다 */
const CLAUDE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAMPLE_CLOSED = "0f0e0d0c-0b0a-4909-8807-060504030201";

/** herdr-app check가 그래프를 그리는 코드까지 확인할 수 있게 하는 작은 견본 */
const SAMPLE = (() => {
  const node = (id, title, status, x, extra = {}) => ({
    id, title, after: [], status, attempts: status === "todo" ? 0 : 1, spentMs: 65000, skills: [], flags: [], tries: [], spawns: [], seen: true, instant: false, ...extra,
  });
  // 견본은 화면의 모든 갈래를 한 번씩 지나가게 만든다 (herdr-app check가 이걸로 그려 본다):
  // 다시 한 노드, 서브에이전트가 도운 회차, 훅이 보지 못한 회차, 한꺼번에 적은 회차, 새 세션에 맡긴 노드, 빠진 노드
  const who = { kind: "me", session: "s1", agents: [{ id: "a1", kind: "Explore" }] };
  const tries = [
    { n: 1, startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:01:00.000Z", spentMs: 60000, status: "done", note: "처음 결과", who: { kind: "me", session: "s1", agents: [] }, skills: [], seen: false, instant: false },
    { n: 2, startedAt: "2026-01-01T00:02:00.000Z", endedAt: "2026-01-01T00:02:01.000Z", spentMs: 1000, status: "blocked", note: "막힘", who: { kind: "subagent", session: "s1", agents: [{ id: "a2", own: true }] }, skills: [], seen: true, instant: true },
    { n: 3, startedAt: "2026-01-01T00:03:00.000Z", spentMs: 5000, status: "doing", who, seen: true, instant: false,
      skills: [{ skill: "team-rules", state: "read", count: 2, via: "file", agent: true, guess: true }, { skill: "spec-reader", state: "loaded", count: 0, via: "tool" }] },
  ];
  const nodes = [
    node("read", "티켓·기획 읽기", "done", 28, { note: "요구사항 2건", skills: [{ skill: "spec-reader", state: "read", count: 1, via: "tool" }] }),
    node("impl", "구현", "doing", 308, { session: "s1", attempts: 3, who, tries, skills: tries[2].skills, run: "session", show: "pane", offPlan: true,
      spawn: { at: "2026-01-01T00:00:00.000Z", terminal: "t9", task: "견본으로 맡긴 말" }, spawns: [{ at: "2026-01-01T00:00:00.000Z", terminal: "t9", task: "견본으로 맡긴 말" }] }),
    node("pr", "PR 올리기", "waiting", 588, { note: "PR 올릴까요?", seen: false, closed: true, session: SAMPLE_CLOSED, flags: [{ at: "2026-01-01T00:00:00.000Z", text: "견본" }] }),
  ];
  const work = {
    work: "sample", title: "견본 작업", request: "견본", state: "waiting", updatedAt: "2026-01-01T00:00:00.000Z",
    counts: { total: 3, todo: 0, doing: 1, waiting: 1, blocked: 0, done: 1 },
  };
  return {
    works: [
      { ...work, past: false, active: [{ id: "pr", title: "PR 올리기", status: "waiting", note: "PR 올릴까요?" }] },
      { ...work, work: "stalled", title: "멈춘 작업", state: "stalled", past: false, active: [{ id: "x", title: "하던 일", status: "doing", closed: true }] },
      { ...work, work: "old", title: "지난 작업", state: "done", past: true, active: [] },
    ],
    errors: [],
    sessions: [{ key: "s1", terminal: "t1", work: "sample", seenAt: "2026-01-01T00:00:00.000Z" }],
    suggest: false,
    selected: {
      ...work, nodes, edges: [], outside: [], compacts: [], flags: [], lead: "s1", helpers: { sessions: 1, subagents: 2 },
      gone: [{ at: "2026-01-01T00:00:00.000Z", id: "lint", title: "lint", status: "todo", why: "견본" }],
      changes: [{ at: "2026-01-01T00:00:00.000Z", by: "human", why: "견본", first: false, added: ["pr"], removed: [], changed: [] }],
      sessions: { s1: { label: "t1", tool: "claude", terminal: "t1" }, [SAMPLE_CLOSED]: { label: "t2", tool: "claude", terminal: "t2", cwd: "/tmp/sample repo" } },
      resumable: [SAMPLE_CLOSED], exists: { "/tmp/sample repo": true },
      layout: {
        width: 840, height: 118,
        nodes: nodes.map((n, i) => ({ id: n.id, x: 28 + i * 280, y: 28, w: 224, h: 62 })),
        edges: [
          { key: "read|impl", from: "read", to: "impl", points: [[252, 59], [308, 59]] },
          { key: "impl|pr", from: "impl", to: "pr", points: [[532, 59], [588, 59]] },
        ],
      },
    },
  };
})();

/**
 * 자리마다 다른 모양으로 쓴다 (레이아웃이나 pane의 props.variant)
 *   full (기본): 작업 목록 + 그래프 + 기록. muwi open으로 터미널 옆에 연 칸
 *   list:        작업 목록만 (사이드바의 Agents 자리. muwi layout이 넣는다)
 *   graph:       그래프와 기록만 (터미널 아래. 목록은 사이드바에서 고른다)
 * 고른 작업은 shared 상태로 칸끼리 나눠 쓴다. props.work를 주면 그 작업에 고정한다.
 */
export default class Muwi extends View {
  init(_props, cx) {
    this.data = null;
    this.error = null;
    this.selected = null;
    this.node = null;
    /** 기록 칸에서 보는 탭: work(시킨 말·계획이 바뀐 기록) 또는 node(고른 노드) */
    this.tab = "work";
    /** 좁은 칸(기록이 그래프 아래)에서 기록을 폈는가. 넓은 칸은 늘 펴 둔다 */
    this.drawer = false;
    this.size = { width: 900, height: 400 };
    this.loading = false;
    this.again = false;
    this.watching = false;
    this.lastLoad = 0;
    this.pan = { x: 0, y: 0 };
    this.zoom = 1;
    this.press = null;
    this.canvasSize = null;
    this.focusKey = null;
    this.stale = false;
    this.showPast = false;
    /** 접어 둔 묶음 (작업 목록의 "나를 기다림" 같은 것) */
    this.folded = new Set();
    /** 키보드가 있는 터미널과 그 작업. 바뀔 때만 따라간다 (사람이 고른 것을 덮어쓰지 않게) */
    this.followKey = null;
    this.followTo = null;
    /** 키보드가 있는 터미널의 세션이 계획 없이 일하는 중이다 */
    this.planless = false;
    /** 계획 없는 세션을 보게 된 때의 PICKED. 그 뒤 누가 작업을 고르면 빈 화면을 푼다 */
    this.planlessSince = 0;
    /** 화면 바꾸기 안내 */
    this.applying = false;
    this.bannerNote = null;
    this.bannerClosed = false;
    /** 그래프 칸의 자리를 바꾸는 중 */
    this.moving = false;
    /** 그래프를 위→아래로 그렸는가 (마지막으로 읽은 것) */
    this.loadedDown = null;
    /** 읽어 둔 작업의 그래프 (작업 → 마지막으로 읽은 것). 탭을 옮기면 이것을 바로 보여 주고 새로 읽는 것은 뒤에서 한다 */
    this.views = new Map();
    /** 오른쪽 기록 칸의 너비. 경계를 끌어서 바꾸고, 바꾼 너비를 기억한다 */
    this.detailW = (() => {
      try {
        const w = Number(localStorage.getItem("detailW"));
        return w >= DETAIL_MIN && w <= 900 ? w : 300;
      } catch {
        return 300;
      }
    })();
    this.resizing = null;
    if (checking()) {
      this.data = SAMPLE;
      this.node = "impl";
      this.tab = "node";
      return;
    }
    this.load(cx);
    this.watch(cx);
    // 다른 칸에서 작업을 바꿨으면 바로, 아니면 15초마다 다시 읽는다 (걸린 시간 갱신, 폴더 감시가 안 될 때 대비).
    // 다시 읽을 때만 화면을 다시 그린다
    cx.timer.every(1000, (cx) => {
      if (this.stale || Date.now() - this.lastLoad > 15000) {
        this.stale = false;
        this.load(cx);
      } else if (this.ticking() || (this.opening && Date.now() - this.opening.at < OPENING_MS + 1000)) {
        cx.notify(); // 진행 중인 노드의 작업 시간을 초마다 늘리고, "여는 중…"을 제때 푼다
      }
    });
    // 키보드가 다른 터미널로 옮겨 가면 곧바로 그 작업으로 바꾼다 (그리는 중에는 공유 상태를 바꾸지 않는다).
    // 사이드바 목록과 그래프 칸은 따로 돈다. 다른 칸이 먼저 골랐어도 이 칸은 이 칸대로 바로 읽는다
    cx.timer.every(50, (cx) => {
      if (this.followTo) {
        const work = this.followTo;
        this.followTo = null;
        if (work !== this.wanted()) this.select(work, cx);
        else this.load(cx);
      } else if (this.stale && !this.loading) {
        this.stale = false;
        this.load(cx);
      }
    });
  }

  variant() {
    const v = (blockProps() ?? {}).variant;
    return v === "list" || v === "graph" ? v : "full";
  }

  /** 그래프를 위→아래로 그릴까: 칸이 세로로 길 때. 크기를 모르면 그래프 칸이 터미널 오른쪽에 있는지로 짐작한다 */
  wantsDown() {
    const s = this.canvasSize;
    if (s) return s.height > s.width * 1.15;
    if (checking() || this.variant() === "list") return false;
    return findNode(shownLayout(), "muwi-split")?.type === "row";
  }

  pinned() {
    const w = (blockProps() ?? {}).work;
    return typeof w === "string" && w ? w : null;
  }

  runsDir() {
    return `${home()}/.muwi`;
  }

  /** 지금 고른 작업: 고정된 작업 → 칸끼리 나눠 쓰는 선택 → 이 칸의 선택 */
  wanted() {
    return this.pinned() ?? shared(SELECTED) ?? this.selected ?? null;
  }

  watch(cx) {
    cx.spawn(async (cx) => {
      try {
        this.watching = true;
        for (;;) {
          await watchFolder(this.runsDir());
          this.load(cx);
        }
      } catch {
        this.watching = false;
      }
    });
  }

  load(cx) {
    if (this.loading) {
      this.again = true;
      return;
    }
    this.loading = true;
    this.stale = false; // 지금 고른 작업을 읽으므로 따로 다시 읽을 것이 없다
    cx.spawn(async (cx) => {
      try {
        const want = this.wanted();
        const args = want ? ["board", "--work", String(want)] : ["board"];
        // 세로로 긴 칸이면 위→아래로 그린다
        const down = this.wantsDown();
        if (down) args.push("--down");
        const r = await runMuwi(args, { timeout: 20000 });
        if (r.code !== 0) throw new Error(r.stderr.trim() || `muwi가 ${r.code}로 끝났어요`);
        const data = JSON.parse(r.stdout);
        // 고른 작업이 없어졌으면 맨 위 작업으로
        if (want && !data.selected && data.works.length) {
          this.selected = null;
          if (!this.pinned()) setShared(SELECTED, null);
          this.again = true;
        }
        this.data = data;
        if (data.selected) {
          this.views.delete(data.selected.work); // 최근 것을 뒤로 (오래된 것부터 버린다)
          this.views.set(data.selected.work, data.selected);
          if (this.views.size > 40) this.views.delete(this.views.keys().next().value);
        }
        this.error = null;
        this.loadedDown = down;
        if (this.node && !data.selected?.nodes.some((n) => n.id === this.node)) {
          this.node = null;
          this.tab = "work";
        }
      } catch (e) {
        this.error = String(e?.message ?? e);
      } finally {
        this.loading = false;
        this.lastLoad = Date.now();
        cx.notify();
        if (this.again) {
          this.again = false;
          this.load(cx);
        }
      }
    });
  }

  /** 지금 보는 작업에 시간이 흐르는 노드가 있는가 (하던 세션이 닫힌 노드는 멈춰 있다) */
  ticking() {
    return (this.data?.selected?.nodes ?? []).some((n) => n.status === "doing" && !n.closed);
  }

  /**
   * 작업 시간. muwi가 읽은 때까지의 시간이라, 진행 중이면 그 뒤로 흐른 시간을 더한다.
   * running: 노드면 진행 중이고 세션이 열려 있을 때, 회차면 그 회차가 아직 열려 있을 때
   */
  spent(ms, running, now) {
    return running ? ms + Math.max(0, now - (this.data?.now ?? now)) : ms;
  }

  select(work, cx) {
    this.selected = work;
    // 사람이 작업을 골랐다 (또는 따라간 터미널에 작업이 있다). 계획 없는 세션의 빈 화면 대신 그 작업을 보여 준다
    this.planless = false;
    this.node = null;
    this.tab = "work";
    this.focusKey = null;
    if (!this.pinned()) {
      setShared(SELECTED, work);
      setShared(PICKED, Date.now());
    }
    this.load(cx);
  }

  /**
   * 터미널 → 그 터미널에서 지금 도는 세션이 붙어 있는 작업 (계획이 없으면 undefined).
   * 세션이 시작될 때 터미널에 붙인 이름표가 있으면 그것을, 없으면 그 터미널에서 가장 최근에 본 세션을 쓴다
   */
  links() {
    const sessions = this.data?.sessions ?? [];
    const map = new Map();
    for (const s of sessions) if (!map.has(s.terminal)) map.set(s.terminal, s.work); // 최근 것이 먼저 온다
    if (checking()) return map;
    for (const t of terminals() ?? []) {
      const key = t.labels?.[LABEL_SESSION];
      if (!key) continue;
      map.set(t.address, sessions.find((x) => x.key === key)?.work);
    }
    return map;
  }

  /**
   * 키보드가 있는 터미널이 바뀌었거나 그 터미널의 세션이 새 작업에 붙었으면 그 작업을 보여 준다.
   * 같은 터미널에 머무는 동안에는 사람이 고른 작업을 덮어쓰지 않는다
   */
  follow(links) {
    if (this.pinned() || !this.data || checking()) return;
    const term = focused()?.terminal ?? null;
    if (!term) return; // 그래프 칸 같은 mod 칸에 키보드가 있다
    const work = links.get(term);
    const known = Boolean(work) && (this.data.works ?? []).some((w) => w.work === work);
    // 에이전트가 떴는지도 함께 본다. 새 탭은 셸로 시작해서 그 뒤에 claude가 뜨므로, 뜨는 순간 다시 따져야
    // "그래프 없음"으로 바뀐다 (터미널이 바뀔 때만 따지면 전에 보던 작업이 그대로 남는다)
    const agent = agents().some((a) => a.address === term);
    const key = `${term}|${known ? work : ""}|${agent ? "agent" : ""}`;
    if (key === this.followKey) return;
    this.followKey = key;
    this.planless = !known && agent;
    this.planlessSince = shared(PICKED) ?? 0;
    if (known) {
      // 전에 본 작업이면 기억해 둔 그래프를 바로 보여 준다. 새로 읽는 것은 타이머가 곧바로 한다
      this.showCached(work);
      this.followTo = work;
    }
  }

  /** 기억해 둔 그 작업의 그래프를 바로 보여 준다 (그리는 중에 불러도 된다: 이 칸의 상태만 바꾼다) */
  showCached(work) {
    const cached = this.views.get(work);
    if (cached && this.data && this.data.selected?.work !== work) this.data = { ...this.data, selected: cached };
  }

  /** 그 터미널로 간다. pane에 있으면 그 pane으로, pane 없이 떠 있으면 그 자리에서 들여다본다 */
  go(terminal) {
    if (!terminal || checking()) return;
    if (panes().some((p) => p.terminal === terminal)) run("pane.focus", { terminal });
    else if (this.alive(terminal)) run("terminal.peek", { terminal });
    // 누르는 사이에 터미널이 닫혔다. 앱의 오류(terminal.peek failed) 대신 무슨 일인지 알린다
    else notify({ title: "그 세션의 터미널이 닫혔어요", body: "기록 칸의 \"이어서 하려면\"에서 이어 갈 수 있어요.", level: "info" });
  }

  /** 그 노드를 하는 세션의 터미널로 간다 (카드를 두 번 눌렀을 때). 아직 아무도 하지 않은 노드면 할 것이 없다 */
  goNode(view, n) {
    const terminal = this.terminalOf(view, n);
    if (terminal) this.go(terminal);
  }

  /** 그 터미널이 아직 떠 있는가. 세션을 끝내거나 터미널을 닫으면 없어져서 그리로 갈 수 없다 */
  alive(terminal) {
    if (!terminal) return false;
    if (checking()) return true; // herdr-app check는 견본으로 버튼까지 그려 본다
    return panes().some((p) => p.terminal === terminal) || (terminals() ?? []).some((x) => x.address === terminal);
  }

  colors(t) {
    // 나를 기다림은 Herdr가 "사람이 필요함"에 쓰는 색, 막힘은 그와 구별되는 색
    return { todo: t.input, doing: t.working, waiting: t.blocked, blocked: t.ansi5 ?? t.blocked, done: t.done, idle: t.muted, stalled: t.muted };
  }

  render(_cx) {
    const t = theme();
    const now = Date.now();
    const variant = this.variant();
    const works = this.data?.works ?? [];
    const links = this.links();
    // 키보드가 다른 터미널로 옮겨 갔으면 그 터미널의 작업으로
    this.follow(links);
    // 다른 칸에서 작업을 바꿨으면 따라간다
    const want = this.wanted();
    let loaded = this.data?.selected ?? null;
    // 다른 칸에서 작업을 바꿨다: 기억해 둔 그 작업의 그래프를 바로 보여 주고, 새로 읽는 것은 타이머가 곧바로 한다.
    // 키보드를 따라 다른 작업으로 가는 중이면(followTo) 그 작업이 맞다. 공유 선택은 타이머가 곧 바꾼다
    const target = this.followTo ?? want;
    if (!checking() && target && loaded && loaded.work !== target && !this.loading) {
      this.stale = true;
      this.showCached(target);
      loaded = this.data?.selected ?? null;
    }
    // 다른 칸(사이드바 목록)에서 작업을 골랐으면 빈 화면을 풀고 그 작업을 보여 준다
    if (this.planless && (shared(PICKED) ?? 0) !== this.planlessSince) this.planless = false;
    // 키보드가 있는 세션이 계획 없이 일한다: 다른 작업의 그래프를 띄우면 그 세션이 그 일을 하는 것처럼 보이므로 비워서 보여 준다.
    // 목록에서 작업을 고르면 다시 그 작업을 보여 준다
    const view = this.planless ? null : loaded;
    const root = v_flex().id("root").size_full().min_h(0).text_color(t.foreground).text_size(12)
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.size.width) > 1 || Math.abs(size.height - this.size.height) > 1) {
          this.size = { width: size.width, height: size.height };
          cx.notify();
        }
      })
      // 오른쪽 기록 칸의 경계를 끄는 중이면 너비를 바꾼다. 그래프 칸이 너무 좁아지지 않게 막는다
      .on_mouse_move((e, cx) => {
        if (!this.resizing) return;
        const max = Math.max(DETAIL_MIN, Math.min(900, this.size.width - 360));
        const w = Math.round(Math.max(DETAIL_MIN, Math.min(max, this.resizing.w + (this.resizing.x - e.position.x))));
        if (w !== this.detailW) {
          this.detailW = w;
          cx.notify();
        }
      })
      .on_mouse_up("left", () => this.endResize())
      .on_hover((hovered) => { if (!hovered) this.endResize(); });

    // 그래프만 그리는 칸은 목록이 필요 없다
    const groups = this.data && variant !== "graph" ? this.groups(t, works, links) : [];
    const listed = groups.length > 0 || works.length > 0;

    if (variant === "list") {
      // 사이드바를 좁혀 아이콘만 보이게 했을 때 (Herdr의 Agents 칸과 같은 기준)
      const compact = this.size.width < 160;
      return root.bg(t.chrome).border_t(1).border_color(t.border)
        .when(!compact, (el) => el.child(this.listHead(t, works, true)))
        .when(Boolean(this.error), (el) => el.child(this.problem(t)))
        .when(!this.error && this.data !== null && !listed, (el) => el.child(this.empty(t)))
        .when(listed, (el) => el.child(this.list(t, works, groups, view?.work, now, true, compact)));
    }

    // 기록 칸 자리: 칸이 넓거나 가로로 길면 그래프 오른쪽, 좁고 세로로 길면(그래프 칸을 오른쪽에 뒀을 때) 그래프 아래
    const wide = this.size.width >= 1040 || (this.size.width >= 640 && this.size.width >= this.size.height * 1.3);
    // 그래프가 너무 좁아지지 않게 칸 크기에 맞춰 줄여 그린다 (기억한 너비는 그대로)
    const detailW = Math.max(DETAIL_MIN, Math.min(this.detailW, this.size.width - 360));
    const drawerH = Math.round(Math.min(240, Math.max(140, this.size.height * 0.3)));
    const showList = variant === "full" && this.size.width >= 720 && !this.pinned();
    const body = h_flex().flex_1().min_h(0)
      .when(showList, (el) => el.child(
        v_flex().w(236).flex_none().h_full().min_h(0).bg(t.chrome).border_r(1).border_color(t.border)
          .child(this.listHead(t, works, false))
          .child(this.list(t, works, groups, view?.work, now, true, false))))
      .child(v_flex().flex_1().min_w(0).h_full().min_h(0)
        .when(!showList && variant === "full" && works.length > 1 && !this.pinned(), (el) => el.child(this.chips(t, works, view?.work)))
        .child(view ? this.canvas(t, view, now) : this.planless && works.length > 0 ? this.planlessNote(t) : div().flex_1())
        .when(Boolean(view) && !wide, (el) => el.child(
          div().flex_none().h(this.drawer ? 36 + drawerH : 36).border_t(1).border_color(t.border).bg(t.surface)
            .child(this.detailPane(t, view, now, true)))))
      .when(Boolean(view) && wide, (el) => el
        // 경계: 끌어서 오른쪽 기록 칸의 너비를 바꾼다
        .child(div().id("detail-edge").w(6).ml(-3).mr(-3).flex_none().h_full().cursor_col_resize()
          .when(Boolean(this.resizing), (el2) => el2.bg(t.accent))
          .when(!this.resizing, (el2) => el2.hover((s) => s.bg(t.border)))
          .on_mouse_down("left", (e, cx) => {
            cx.stop_propagation();
            this.resizing = { x: e.position.x, w: detailW };
            cx.notify();
          }))
        .child(div().w(detailW).flex_none().h_full().min_h(0).border_l(1).border_color(t.border).bg(t.surface).child(this.detailPane(t, view, now, false))));

    const banner = this.banner(t, variant);
    return root.bg(t.canvas)
      .child(this.head(t, view, works, now))
      .when(Boolean(banner), (el) => el.child(banner))
      .when(Boolean(this.error), (el) => el.child(this.problem(t)))
      .when(!this.error && this.data !== null && works.length === 0, (el) => el.child(this.empty(t)))
      .when(!this.error && this.data === null, (el) => el.child(div().p(16).text_color(t.dim).child("불러오는 중…")))
      .when(works.length > 0, (el) => el.child(body));
  }

  pill(t, text, color) {
    return h_flex().h(18).px(7).flex_none().items_center().rounded(9).bg(tint(color, 0.16)).border_1().border_color(tint(color, 0.55))
      .text_size(10.5).font_medium().text_color(color).child(text);
  }

  head(t, view, works, now) {
    const c = this.colors(t);
    const place = this.placeControl(t);
    const legend = (text, color) => h_flex().gap(5).items_center()
      .child(div().size(8).rounded_full().bg(color))
      .child(div().text_size(10.5).text_color(t.dim).child(text));
    return h_flex().id("head").flex_none().h(44).px(16).gap(10).items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(h_flex().gap(8).items_center()
          .child(div().min_w(0).truncate().text_size(13).font_semibold().child(view ? (view.title ?? view.work) : this.planless ? "계획 없는 세션" : "작업 그래프"))
          .when(Boolean(view), (el) => el.child(this.pill(t, STATE_NAME[view.state] ?? view.state, c[view.state] ?? t.muted))))
        .child(div().truncate().text_size(10.5).text_color(t.dim).child(
          // 지금 보는 터미널의 세션은 계획 없이 일한다
          !view && this.planless ? "지금 칸의 세션은 계획 없이 진행 중이에요"
            : view ? [`${view.work} · ${view.counts.done}/${view.counts.total} 끝 · ${ago(view.updatedAt, now)}`,
              view.helpers?.sessions ? `새 세션 ${view.helpers.sessions}` : null,
              view.helpers?.subagents ? `서브에이전트 ${view.helpers.subagents}` : null].filter(Boolean).join(" · ") : `${works.length}개 작업`)))
      .when(Boolean(view) && this.size.width >= 860, (el) => el.child(h_flex().flex_none().gap(12)
        .child(legend("작업 중", c.doing)).child(legend("나를 기다림", c.waiting)).child(legend("막힘", c.blocked)).child(legend("끝", c.done))))
      .when(Boolean(place), (el) => el.child(place));
  }

  /** 지금 그래프 칸의 자리. muwi layout이 만든 화면의 그래프 칸이 아니면 null (옮길 수 없다) */
  graphAtNow() {
    if (checking() || this.variant() !== "graph") return null;
    const split = findNode(shownLayout(), "muwi-split");
    if (!split) return null;
    return split.type === "row" ? "right" : split.children?.[0]?.id === "muwi-graph" ? "top" : "bottom";
  }

  /**
   * 그래프 칸의 자리 고르기: 위 · 아래 · 오른쪽. muwi layout이 만든 화면의 그래프 칸에만 둔다.
   * 누르면 지금 레이아웃에서 그래프 칸만 그 자리로 옮긴다 (muwi layout --graph, 레이아웃은 그대로라 번쩍이지 않는다)
   */
  placeControl(t) {
    const now = this.graphAtNow();
    if (!now) return null;
    const opt = (where) => {
      const on = now === where;
      return div().id(`at-${where}`).h(20).px(7).flex().items_center().rounded(5).text_size(10.5)
        .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.dim)
        .when(!on && !this.moving, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.moveGraph(where, cx)))
        .child(PLACE_NAME[where]);
    };
    return h_flex().id("place").flex_none().gap(2).p(2).items_center().rounded(7).border_1().border_color(t.border).bg(t.chrome)
      .when(this.moving, (el) => el.child(div().px(5).text_size(10.5).text_color(t.dim).child("옮기는 중…")))
      .child(opt("top")).child(opt("bottom")).child(opt("right"));
  }

  /** 경계 끌기를 끝내고 너비를 기억한다 */
  endResize() {
    if (!this.resizing) return;
    this.resizing = null;
    try {
      localStorage.setItem("detailW", String(this.detailW));
    } catch {
      // 기억하지 못해도 이번에는 그 너비로 그린다
    }
  }

  /** 그래프 칸을 다른 자리로 옮긴다. 레이아웃을 다시 만들면 이 칸은 새로 뜬다 */
  moveGraph(where, cx) {
    if (this.moving) return;
    this.moving = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await runMuwi(["layout", "--graph", where], { timeout: 60000 });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `muwi layout이 ${r.code}로 끝났어요`);
      } catch (e) {
        notify({ title: "그래프 자리를 바꾸지 못했어요", body: String(e?.message ?? e), level: "error" });
      } finally {
        this.moving = false;
        cx.notify();
      }
    });
  }

  listHead(t, works, sidebar) {
    const waiting = works.filter((w) => w.state === "waiting").length;
    const running = works.filter((w) => w.state === "doing").length;
    // 사이드바에서는 Herdr의 Agents 칸 머리와 같은 자리에 맞춘다
    return h_flex().px(sidebar ? 16 : 14).h(sidebar ? 41 : 36).when(sidebar, (el) => el.pt(14).pb(5)).flex_none().items_center().gap(6)
      .child(div().flex_1().text_size(11.5).font_medium().text_color(t.dim).child("작업"))
      .when(running > 0, (el) => el.child(h_flex().gap(3).items_center().text_size(10.5).text_color(t.working)
        .child(div().frames(SPIN, 90)).child(String(running))))
      .when(waiting > 0, (el) => el.child(
        h_flex().h(18).px(6).flex_none().items_center().rounded(5).bg(t.blocked).text_size(10.5).font_semibold()
          .text_color(t.background).child(`⏸ ${waiting}`)));
  }

  problem(t) {
    return v_flex().p(14).gap(6).text_size(12)
      .child(div().text_color(t.blocked).font_semibold().child("기록을 읽지 못했어요"))
      .child(div().text_color(t.muted).child(this.error ?? ""))
      .child(div().text_color(t.dim).child("Claude Code 세션에서 muwi setup을 실행하면 ~/.local/bin/muwi가 생겨요 (Windows는 muwi.cmd)."));
  }

  /**
   * 하던 세션의 터미널이 닫힌 노드를 이어서 하는 버튼. 누르면 그 세션이 일하던 폴더에서 새 탭으로 열린다:
   *   하던 대화 다시 열기: Claude 세션이면 claude --resume <세션 id>. 하던 대화 내용이 그대로 남아 있다
   *   새 대화로 이어 가기: "<작업> 작업의 <노드> 노드 이어서 해줘"로 새 대화를 연다. muwi 기록(계획·결과)을 읽고 이어 간다
   * 맡긴 세션이 기록을 남기기 전에 닫혔으면 세션 정보가 없으니 그 세션을 띄운 폴더(worktree일 수 있다)에서 새 대화로 연다
   */
  resumeHints(t, view, n) {
    const key = n.session ?? null;
    const s = key ? view.sessions?.[key] : null;
    const unstarted = !key && Boolean(n.spawn);
    // 그 세션이 일하던 폴더. 없어졌으면(worktree를 지웠다) 작업 폴더에서 연다. 없는 폴더에서는 터미널이 뜨지 않는다
    const want = s?.cwd ?? (unstarted ? n.spawn.cwd : null) ?? null;
    const folder = [want, view.cwd].find((p) => this.folderOk(view, p)) ?? null;
    const moved = want && !this.folderOk(view, want) ? want : null;
    const tool = s?.tool === "codex" ? "codex" : "claude";
    const buttons = [];
    // 대화 파일이 남아 있고 그 폴더가 그대로일 때만 다시 열 수 있다 (아니면 claude가 "No conversation found"로 끝난다)
    if (s?.tool === "claude" && CLAUDE_ID.test(key) && (view.resumable ?? []).includes(key) && !moved) {
      buttons.push(this.openRow(t, `resume-${n.id}`, "하던 대화 다시 열기", "전에 하던 대화 내용이 그대로 남아 있어요", ["claude", "--resume", key], folder, n.id));
    }
    if (n.status !== "done") {
      buttons.push(this.openRow(t, `continue-${n.id}`, "새 대화로 이어 가기", unstarted ? "muwi 기록(계획·맡긴 말)을 읽고 이어 가요" : "muwi 기록(계획·결과)을 읽고 이어 가요",
        [tool, `${view.work} 작업의 ${n.id} 노드 이어서 해줘`], folder, n.id));
    }
    if (!buttons.length) return { rows: [], choices: 0 };
    const note = (text) => div().text_size(10.5).text_color(t.dim).child(text);
    const rows = [
      ...(unstarted ? [note("맡긴 세션이 일을 시작하기 전에 닫혔어요")] : []),
      ...buttons,
      ...(moved ? [note(`원래 폴더(${this.shortPath(moved)})가 없어져서 ${folder ? `${this.shortPath(folder)}에서` : "기본 폴더에서"} 새 탭으로 열려요`)]
        : folder ? [note(`누르면 ${this.shortPath(folder)}에서 새 탭으로 열려요`)] : []),
    ];
    return { rows, choices: buttons.length };
  }

  /** 그 폴더가 아직 있는가. muwi board가 알려 준 것을 쓰고, 모르면 있다고 본다 */
  folderOk(view, p) {
    return Boolean(p) && view.exists?.[p] !== false;
  }

  /** 누르면 그 폴더에서 새 탭으로 여는 버튼과, 그 아래 무엇이 열리는지 한 줄 */
  openRow(t, id, text, about, argv, folder, name) {
    const busy = this.opening?.id === id && Date.now() - this.opening.at < OPENING_MS;
    return v_flex().gap(3)
      .child(h_flex().child(h_flex().id(`open-${id}`).h(26).px(10).flex_none().items_center().rounded(6).bg(t.raised).border_1().border_color(t.border)
        .text_size(11.5).text_color(busy ? t.dim : t.foreground)
        .when(!busy, (el) => el.cursor_pointer().hover((st) => st.bg(t.hover)))
        .on_click((_e, cx) => { this.openTerminal(id, argv, folder, name); cx.notify(); })
        .child(busy ? "여는 중…" : text)))
      .child(div().text_size(10.5).text_color(t.dim).child(about));
  }

  /** 새 탭에서 명령을 연다 (그 세션이 일하던 폴더에서). 연달아 눌러도 한 번만 연다 */
  openTerminal(id, argv, folder, name) {
    if (checking()) return;
    if (this.opening?.id === id && Date.now() - this.opening.at < OPENING_MS) return;
    this.opening = { id, at: Date.now() };
    run("terminal.open", { argv, ...(folder ? { folder } : {}), ...(name ? { name } : {}) });
  }

  /** 홈 폴더는 ~로 줄여 보여 준다 */
  shortPath(p) {
    const h = checking() ? "" : home();
    return h && p.startsWith(h) ? `~${p.slice(h.length)}` : p;
  }

  /** 키보드가 있는 세션이 계획 없이 일할 때 그래프 자리 */
  planlessNote(t) {
    return v_flex().flex_1().min_h(0).items_center().justify_center().gap(6).p(16)
      .child(div().text_size(13).text_color(t.muted).child("그래프 없음"))
      .child(div().text_size(11).text_color(t.dim).child("지금 칸의 세션은 계획 없이 일하고 있어요. 질문에 답하거나 한 번에 끝나는 일이에요."))
      .child(div().text_size(11).text_color(t.dim).child("여러 단계로 하는 일을 시키면 계획이 여기에 그려져요. 다른 작업은 목록에서 고르세요."));
  }

  empty(t) {
    return v_flex().p(16).gap(6)
      .child(div().text_color(t.muted).child("기록된 작업이 없어요."))
      .child(div().text_color(t.dim).text_size(11).child("에이전트에게 일을 시키면, 에이전트가 짠 계획이 여기에 그려져요."));
  }

  workMark(t, w, c, ask = false) {
    // 그 작업을 하는 세션이 입력을 기다린다 (권한 확인 같은 것). 사람이 가 봐야 한다
    if (ask) return div().w(14).flex_none().text_color(c.waiting).font_semibold().child("!");
    if (w.state === "doing") return div().w(14).flex_none().text_color(c.doing).frames(SPIN, 90);
    const mark = { waiting: "⏸", blocked: "✗", stalled: "◌", done: "✓", idle: "○" }[w.state] ?? "•";
    return div().w(14).flex_none().text_color(c[w.state] ?? t.muted).child(mark);
  }

  /**
   * 작업 목록의 묶음. 급한 순서: 나를 기다림 → 막힘 → 작업 중 → 멈춤 → 노드 사이 → 계획 없는 세션 → 끝.
   * 계획 없이 일하는 세션(작업에 붙지 않은 에이전트)도 넣는다. 그래서 Herdr의 Agents 칸이 없어도 모든 세션이 보인다.
   * 세션이 입력을 기다리면(권한 확인 같은 것) 그 작업이나 세션을 "나를 기다림"으로 올린다
   */
  groups(t, works, links) {
    const c = this.colors(t);
    const current = works.filter((w) => !w.past);
    const open = new Set(current.filter((w) => w.state !== "done").map((w) => w.work));
    const byWork = new Map();
    const free = [];
    for (const a of checking() ? [] : agents()) {
      const work = links.get(a.address);
      if (work && open.has(work)) byWork.set(work, [...(byWork.get(work) ?? []), a]);
      else free.push(a);
    }
    const bucket = { need: [], blocked: [], doing: [], stalled: [], idle: [], free: [], done: [] };
    for (const w of current) {
      const mine = byWork.get(w.work) ?? [];
      const item = { kind: "work", w, agents: mine, ask: mine.some((a) => a.status === "blocked") };
      if (w.state === "waiting" || item.ask) bucket.need.push(item);
      else (bucket[w.state] ?? bucket.idle).push(item);
    }
    const rank = (a) => AGENT_RANK[a.status] ?? 0;
    for (const a of free.sort((x, y) => rank(y) - rank(x) || (y.seq ?? 0) - (x.seq ?? 0))) {
      (a.status === "blocked" ? bucket.need : bucket.free).push({ kind: "agent", a });
    }
    return [
      { id: "need", label: STATE_NAME.waiting, color: c.waiting, items: bucket.need },
      { id: "blocked", label: STATE_NAME.blocked, color: c.blocked, items: bucket.blocked },
      { id: "doing", label: STATE_NAME.doing, color: c.doing, items: bucket.doing },
      { id: "stalled", label: STATE_NAME.stalled, color: t.muted, items: bucket.stalled },
      { id: "idle", label: STATE_NAME.idle, color: t.dim, items: bucket.idle },
      { id: "free", label: "계획 없는 세션", color: t.dim, items: bucket.free },
      { id: "done", label: STATE_NAME.done, color: c.done, items: bucket.done },
    ].filter((g) => g.items.length > 0);
  }

  /**
   * 작업 목록: 묶음 머리와 줄들. 끝났거나 멈춘 채로 오래된 작업(past)은 맨 아래에 "지난 작업 N개"로 접어 둔다. 지우지는 않는다.
   * compact: 사이드바를 좁혀 아이콘만 보일 때
   */
  list(t, works, groups, selected, now, fill, compact) {
    const c = this.colors(t);
    const box = fill ? v_flex().flex_1().min_h(0) : v_flex().flex_none();
    const row = (item) => (item.kind === "work" ? this.workRow(t, c, item, selected, now, compact) : this.agentRow(t, item.a, compact));
    const past = works.filter((w) => w.past);
    // 접어 둔 작업을 보고 있으면 펼쳐 둔다
    const open = this.showPast || past.some((w) => w.work === selected);
    return box.id("works").overflow_y_scrollbar().px(compact ? 4 : 8).pb(8).gap(1)
      .children(groups.flatMap((g) => [
        ...(compact ? [] : [this.groupHead(t, g)]),
        ...(this.folded.has(g.id) && !compact ? [] : g.items.map(row)),
      ]))
      .when(past.length > 0 && !compact, (el) => el
        .child(h_flex().id("past-toggle").px(8).py(6).mt(4).gap(8).items_center().rounded(7).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.showPast = !open; cx.notify(); })
          .child(div().w(14).flex_none().text_size(10).text_color(t.dim).child(open ? "▾" : "▸"))
          .child(div().flex_1().text_size(11).text_color(t.dim).child(`지난 작업 ${past.length}개`)))
        .when(open, (el2) => el2.children(past.map((w) => row({ kind: "work", w, agents: [], ask: false })))));
  }

  /** 묶음 머리. 누르면 접는다 */
  groupHead(t, g) {
    const open = !this.folded.has(g.id);
    return h_flex().id(`sec-${g.id}`).px(8).pt(8).h(28).flex_none().gap(6).items_center().text_size(11).font_medium().cursor_pointer()
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { open ? this.folded.add(g.id) : this.folded.delete(g.id); cx.notify(); })
      .child(div().truncate().text_color(g.color).child(g.label))
      .child(div().text_color(t.dim).child(String(g.items.length)))
      .child(div().flex_1())
      .when(!open, (el) => el.child(div().text_size(10).text_color(t.dim).child("▸")));
  }

  /**
   * 작업으로 갈 때 열 터미널: 지금 그 작업에 붙어 있는 세션 중 입력을 기다리는 것 → 일하는 것.
   * 그 작업을 하는 세션이 없으면(끝났거나 세션이 닫힘) 옮겨 가지 않는다. 그 터미널은 지금 다른 일을 하고 있을 수 있다
   */
  targetOf(item) {
    const best = [...item.agents].sort((x, y) => (AGENT_RANK[y.status] ?? 0) - (AGENT_RANK[x.status] ?? 0))[0];
    return best?.address ?? null;
  }

  /** 작업 한 줄: 제목 / 지금 눈여겨볼 노드. 누르면 그 작업의 그래프를 보여 주고 그 세션의 터미널로 간다 */
  workRow(t, c, item, selected, now, compact) {
    const w = item.w;
    const on = w.work === selected;
    const click = (_e, cx) => {
      this.select(w.work, cx);
      const target = this.targetOf(item);
      // 옮겨 간 터미널이 이 작업을 하고 있으니 따라가기가 다시 바꿀 것이 없다
      if (target) this.followKey = `${target}|${w.work}|agent`;
      this.go(target);
    };
    if (compact) {
      return h_flex().id(`work-${w.work}`).h(26).flex_none().items_center().justify_center().rounded(6)
        .bg(on ? t.selected : t.chrome).hover((s) => s.bg(on ? t.selected : t.hover)).cursor_pointer()
        .on_click(click)
        .child(this.workMark(t, w, c, item.ask));
    }
    const first = w.active.find((n) => n.status === "waiting" && !n.closed) ?? w.active.find((n) => n.status === "blocked" && !n.closed) ?? w.active[0];
    const line = item.ask ? "세션이 입력을 기다림" : w.state === "done" ? "모든 노드가 끝났어요"
      : first ? `${first.title}${first.closed ? " · 세션이 닫힘" : first.note ? ` · ${first.note}` : ""}` : `${w.counts.done}/${w.counts.total} 끝`;
    return h_flex().id(`work-${w.work}`).px(8).py(6).gap(8).items_center().rounded(7)
      .bg(on ? t.selected : t.chrome).hover((s) => s.bg(on ? t.selected : t.hover)).cursor_pointer()
      .on_click(click)
      .child(this.workMark(t, w, c, item.ask))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_size(12).text_color(on ? t.foreground : t.muted).when(on, (el) => el.font_medium()).child(w.title ?? w.work))
        .child(h_flex().gap(6).text_size(10.5)
          .child(div().flex_1().min_w(0).truncate().text_color(item.ask ? c.waiting : c[w.state] ?? t.dim).child(line))
          .child(div().flex_none().text_color(t.dim).child(ago(w.updatedAt, now)))));
  }

  /** 계획 없이 일하는 세션 한 줄 (Herdr의 Agents 칸과 같은 모양). 누르면 그 터미널로 간다 */
  agentRow(t, a, compact) {
    const click = () => run("pane.focus", { pane: a.pane });
    if (compact) {
      return h_flex().id(`ag-${a.address}`).h(26).flex_none().items_center().justify_center().rounded(6)
        .bg(a.focused ? t.selected : t.chrome).hover((s) => s.bg(a.focused ? t.selected : t.hover)).cursor_pointer()
        .on_click(click)
        .child(this.agentStatus(t, a));
    }
    const pic = programIcon(a.program, 14, t.foreground);
    const name = a.space_name || a.tab_name || a.address;
    const title = clean(a.title);
    const more = title && title !== name && title !== a.program?.name ? title : null;
    const quiet = a.status === "idle" && !a.focused;
    return h_flex().id(`ag-${a.address}`).px(8).h(30).flex_none().gap(8).items_center().rounded(7)
      .bg(a.focused ? t.selected : t.chrome).hover((s) => s.bg(a.focused ? t.selected : t.hover)).cursor_pointer()
      .on_click(click)
      .child(h_flex().w(14).flex_none().items_center().justify_center().when(Boolean(pic), (el) => el.child(pic)))
      .child(h_flex().flex_1().min_w(0).gap(5).items_center().text_size(12)
        .child(div().min_w(0).max_w(more ? 110 : 220).truncate().text_color(quiet ? t.muted : t.foreground).child(name))
        .when(Boolean(more), (el) => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`· ${more}`))))
      .child(this.agentStatus(t, a));
  }

  /** 세션 상태 표시 (Herdr의 Agents 칸과 같은 모양): 일하는 중은 도는 원, 입력을 기다리면 !, 쉬는 중은 빈 원 */
  agentStatus(t, a) {
    if (a.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (a.status === "blocked") {
      return div().size(14).flex_none().rounded(4).bg(tint(t.blocked, 0.15)).text_size(10.5).font_bold().text_color(t.blocked)
        .flex().items_center().justify_center().child("!");
    }
    if (a.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).bg(a.status === "done" ? t.done ?? t.dim : t.dim);
  }

  /**
   * 그래프 칸 위쪽의 한 줄 안내.
   *   터미널 옆에 따로 연 칸(full)인데 화면에 muwi 칸이 없으면: 사이드바와 터미널 아래에 고정하자고 (muwi config layout off면 묻지 않는다)
   *   muwi layout으로 만든 화면인데 Herdr가 업데이트됐으면: 새 모양에 맞추자고
   */
  banner(t, variant) {
    if (checking() || !this.data || this.bannerClosed) return null;
    const tree = shownLayout();
    const has = anyNode(tree, (n) => n?.content?.mod === "muwi");
    let text = null, act = null, later = null;
    if (!has && variant === "full" && this.data.suggest) {
      text = "사이드바의 Agents 자리에 작업 목록을 두고, 그래프를 터미널 아래에 고정할 수 있어요. 지금 레이아웃은 그대로 남아요.";
      act = { label: "바꾸기", run: (cx) => this.applyLayout(cx, true) };
      later = { label: "묻지 않기", run: (cx) => this.stopAsking(cx) };
    } else if (has && /^muwi(-\d+)?$/.test(String(shared("layout") ?? ""))) {
      // muwi layout으로 만든 화면이다. 다시 맞출 일이 있는지 본다
      const was = tree?.cloned_from?.version;
      const now = updates()?.app?.version;
      const later0 = { label: "나중에", run: (cx) => { this.bannerClosed = true; cx.notify(); } };
      if (SHIPPED.includes(tree?.cloned_from?.name) && was && now && was !== now) {
        text = `Herdr가 업데이트됐어요 (${was} → ${now}). muwi 화면을 새 모양에 맞출 수 있어요.`;
        act = { label: "맞추기", run: (cx) => this.applyLayout(cx, false) };
        later = later0;
      } else if (anyNode(tree, (n) => n?.id === "muwi-graph") && !anyNode(tree, (n) => n?.id === "muwi-split")) {
        // 옛 배치: 그래프 칸 높이를 바꿀 수 없다
        text = "muwi 화면 배치가 나아졌어요. 다시 맞추면 터미널과 그래프 사이 경계를 끌어서 그래프 높이를 바꿀 수 있어요.";
        act = { label: "맞추기", run: (cx) => this.applyLayout(cx, false) };
        later = later0;
      }
    }
    if (!text) return null;
    const button = (id, b, primary) => h_flex().id(id).h(24).px(10).flex_none().items_center().rounded(6)
      .bg(primary ? t.accent : t.raised).border_1().border_color(primary ? t.accent : t.border)
      .text_size(11).font_medium().text_color(primary ? t.background : t.muted).cursor_pointer()
      .when(!primary, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_click((_e, cx) => b.run(cx))
      .child(b.label);
    return h_flex().flex_none().px(14).py(7).gap(10).items_center().bg(t.surface).border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).text_size(11.5).text_color(this.bannerNote && !this.applying ? t.blocked : t.foreground).child(this.bannerNote ?? text))
      .when(!this.applying, (el) => el.child(button("banner-act", act, true)).child(button("banner-later", later, false)));
  }

  /** muwi layout을 실행한다. 터미널 옆에 따로 연 칸이면 바꾼 뒤 그 칸을 닫는다 (같은 그래프가 두 번 보이지 않게) */
  applyLayout(cx, closeMe) {
    if (this.applying) return;
    this.applying = true;
    this.bannerNote = "바꾸는 중…";
    const me = closeMe ? panes().find((p) => p.mod === "muwi" && p.focused)?.pane ?? null : null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await runMuwi(["layout"], { timeout: 60000 });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `muwi layout이 ${r.code}로 끝났어요`);
        this.applying = false;
        this.bannerNote = null;
        this.bannerClosed = true;
        cx.notify();
        if (me) run("pane.close", { pane: me });
      } catch (e) {
        this.applying = false;
        this.bannerNote = String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  /** 다시 묻지 않는다 (muwi config layout off) */
  stopAsking(cx) {
    this.bannerClosed = true;
    if (this.data) this.data.suggest = false;
    cx.notify();
    cx.spawn(async () => {
      try {
        await runMuwi(["config", "layout", "off"], { timeout: 20000 });
      } catch {
        // 적지 못해도 이 칸에서는 다시 묻지 않는다
      }
    });
  }

  /** 좁을 때는 목록 대신 한 줄로 */
  chips(t, works, selected) {
    const c = this.colors(t);
    return h_flex().id("chips").flex_none().h(34).px(10).gap(6).items_center().overflow_x_hidden().border_b(1).border_color(t.border)
      .children([...works.filter((w) => !w.past), ...works.filter((w) => w.past)].slice(0, 8).map((w) => {
        const on = w.work === selected;
        return h_flex().id(`chip-${w.work}`).h(22).px(8).gap(5).flex_none().items_center().rounded(11)
          .bg(on ? t.selected : t.surface).border_1().border_color(on ? t.accent : t.border).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.select(w.work, cx))
          .child(div().size(7).rounded_full().bg(c[w.state] ?? t.muted))
          .child(div().text_size(11).text_color(on ? t.foreground : t.muted).child(w.work));
      }));
  }

  /** 노드를 맡은 세션의 지금 상태 (Herdr가 아는 것). 터미널을 모르면 null */
  /** 이 노드를 하는 세션의 Herdr 터미널 주소. 맡긴 세션이 아직 뜨는 중이면 띄운 터미널 */
  terminalOf(view, n) {
    return (n.session ? view.sessions?.[n.session]?.terminal : null) ?? (n.status === "todo" ? n.spawn?.terminal : null) ?? null;
  }

  /**
   * 카드 오른쪽 위의 표시: 누가 하는가. 대화가 직접 하면 비워 둔다.
   * planned: 아직 시작 전이고 계획에 그렇게 적혀 있다 (흐리게 그린다)
   */
  tagOf(n) {
    if (n.who) {
      if (n.who.kind === "session") return { text: "세션", planned: false };
      const subs = n.who.agents.length;
      if (n.who.kind === "subagent") return { text: subs > 1 ? `서브 ×${subs}` : "서브", planned: false };
      // 세션이 직접 했고, 그동안 뜬 서브에이전트가 도왔다
      if (subs > 0) return { text: subs > 1 ? `+서브 ×${subs}` : "+서브", planned: false };
      return null;
    }
    if (n.status !== "todo") return null;
    if (n.spawn || n.run === "session") return { text: "세션", planned: true };
    if (n.run === "subagent") return { text: "서브", planned: true };
    return null;
  }

  agentOf(view, n) {
    const terminal = this.terminalOf(view, n);
    if (!terminal) return null;
    return agents().find((a) => a.address === terminal) ?? null;
  }

  statusIcon(t, n, color, size) {
    const circle = () => div().size(size).flex_none().rounded_full().flex().items_center().justify_center();
    // 하던 세션이 닫혔다: 돌지 않는 빈 원으로. 끝난 것도 하는 중도 아니다
    if (n.closed) return circle().border(1.5).border_color(t.muted).text_size(size * 0.62).font_semibold().text_color(t.muted).child("–");
    if (n.status === "doing") {
      return div().size(size).flex_none().relative()
        .child(div().absolute().left(0).top(0).size(size).rounded_full().border(2).border_color(tint(color, 0.28)))
        .child(svg("mods/muwi/arc.svg").absolute().left(0).top(0).size(size).text_color(color).spin(900));
    }
    if (n.status === "waiting") return circle().bg(color).text_size(size * 0.62).font_semibold().text_color(t.background).child("!");
    if (n.status === "blocked") return circle().bg(color).text_size(size * 0.62).font_semibold().text_color(t.background).child("×");
    if (n.status === "done") return circle().bg(color).text_size(size * 0.62).font_semibold().text_color(t.background).child("✓");
    return circle().border(1.5).border_color(t.input);
  }

  /** 카드 둘째 줄: 상태에 따라 가장 궁금한 것 하나 */
  metaOf(view, n, now) {
    const times = n.spentMs > 0 ? dur(this.spent(n.spentMs, n.status === "doing" && !n.closed, now)) : null;
    if (n.closed) return ["세션이 닫힘", times, n.status !== "doing" ? n.note : null].filter(Boolean).join(" · ");
    if (n.status === "waiting" || n.status === "blocked") return n.note ?? STATUS_NAME[n.status];
    if (n.status === "doing") {
      const agent = this.agentOf(view, n);
      const quiet = agent && agent.status !== "working" ? AGENT_NAME[agent.status] : null;
      return [n.who?.kind === "subagent" ? "서브에이전트" : null, times, quiet].filter(Boolean).join(" · ") || "작업 중";
    }
    if (n.status === "done") return [times, n.note].filter(Boolean).join(" · ");
    // 시작했다가 앞에 먼저 할 노드가 끼어들어 잠시 멈췄다
    if (n.paused) return ["잠시 멈춤", times].filter(Boolean).join(" · ");
    if (n.spawn) {
      // 맡긴 세션이 일을 시작하기 전에 터미널이 닫혔다. 더 기다려도 뜨지 않는다
      if (!this.alive(n.spawn.terminal)) return "맡긴 세션이 닫힘";
      // 폴더 신뢰 확인이나 권한 확인에서 멈춰 있으면 그렇게 보여 준다. 사람이 그 칸에서 답해야 한다
      const agent = this.agentOf(view, n);
      return agent?.status === "blocked" ? AGENT_NAME.blocked : "새 세션이 뜨는 중";
    }
    return "";
  }

  centerOn(view) {
    const s = this.canvasSize;
    const L = view.layout;
    if (!s || !L.width) return;
    // 그래프가 칸에 다 들어오면 가운데에. 터미널 아래처럼 낮은 칸은 글자가 읽히는 만큼(0.7배)까지 줄여서 담는다
    const floor = this.variant() === "graph" ? 0.7 : 0.9;
    const fit = Math.min(1, s.width / L.width, s.height / L.height);
    if (fit >= floor) {
      this.zoom = fit;
      this.pan = { x: (s.width - L.width * fit) / 2, y: Math.max(0, (s.height - L.height * fit) / 2) };
      return;
    }
    // 다 담기지 않으면 높이를 읽히는 만큼만 줄이고, 볼 노드를 가운데에 둔다
    const z = Math.max(floor, Math.min(1, s.height / L.height));
    this.zoom = z;
    const ids = this.focusIds(view);
    const boxes = L.nodes.filter((p) => ids.includes(p.id));
    if (!boxes.length) return;
    const x1 = Math.min(...boxes.map((p) => p.x)), x2 = Math.max(...boxes.map((p) => p.x + p.w));
    const y1 = Math.min(...boxes.map((p) => p.y)), y2 = Math.max(...boxes.map((p) => p.y + p.h));
    const clamp = (v, size, full) => (full <= size ? (size - full) / 2 : Math.min(0, Math.max(size - full, v)));
    this.pan = {
      x: clamp(s.width / 2 - ((x1 + x2) / 2) * z, s.width, L.width * z),
      y: clamp(s.height / 2 - ((y1 + y2) / 2) * z, s.height, L.height * z),
    };
  }

  /**
   * 그래프가 칸에 다 담기지 않을 때 보여 줄 노드:
   * 지금 일어나는 노드 → (시작 전이면) 처음 노드 → (다 끝났으면) 흐름의 끝 노드 → 다음에 할 노드
   */
  focusIds(view) {
    const live = view.nodes.filter((n) => n.status === "doing" || n.status === "waiting" || n.status === "blocked").map((n) => n.id);
    if (live.length) return live;
    const done = new Set(view.nodes.filter((n) => n.status === "done").map((n) => n.id));
    if (done.size === 0) return view.nodes.filter((n) => !(n.after ?? []).length).map((n) => n.id);
    if (done.size === view.nodes.length) {
      const before = new Set(view.nodes.flatMap((n) => n.after ?? []));
      return view.nodes.filter((n) => !before.has(n.id)).map((n) => n.id);
    }
    // 노드 사이: 앞 노드가 다 끝났는데 아직 시작하지 않은 노드
    const next = view.nodes.filter((n) => n.status === "todo" && (n.after ?? []).every((a) => done.has(a))).map((n) => n.id);
    return next.length ? next : view.nodes.map((n) => n.id);
  }

  fit(view) {
    const s = this.canvasSize;
    const L = view.layout;
    if (!s || !L.width) return;
    this.zoom = Math.max(0.3, Math.min(1.2, s.width / L.width, s.height / L.height));
    this.pan = { x: (s.width - L.width * this.zoom) / 2, y: Math.max(0, (s.height - L.height * this.zoom) / 2) };
  }

  zoomBy(f, point, L) {
    const next = Math.max(0.3, Math.min(1.6, this.zoom * f));
    const wx = (point.x - this.pan.x) / this.zoom, wy = (point.y - this.pan.y) / this.zoom;
    this.zoom = next;
    this.pan = { x: point.x - wx * next, y: point.y - wy * next };
    this.clampPan(L);
  }

  /**
   * 그래프가 칸 밖으로 밀려나지 않게, 옮길 수 있는 범위를 그래프 크기로 막는다.
   * 그래프가 칸보다 작은 쪽은 칸 안에서 옮기고 가장자리에 닿으면 멈춘다(끌면 움직인다).
   * 큰 쪽은 그래프 끝이 칸 끝에 닿을 때까지만 옮긴다. 처음 보여 줄 때 가운데에 두는 것은 centerOn이 한다
   */
  clampPan(L) {
    const s = this.canvasSize;
    if (!s || !L?.width) return;
    const z = this.zoom;
    const edge = 12;
    // a: 그래프 왼쪽(위쪽) 끝이 칸 가장자리에 닿는 곳, b: 오른쪽(아래쪽) 끝이 닿는 곳. 작은 그래프는 a < b, 큰 그래프는 b < a
    const axis = (v, size, full) => {
      const a = edge, b = size - full - edge;
      return Math.min(Math.max(a, b), Math.max(Math.min(a, b), v));
    };
    this.pan = { x: axis(this.pan.x, s.width, L.width * z), y: axis(this.pan.y, s.height, L.height * z) };
  }

  canvas(t, view, now) {
    const L = view.layout;
    const c = this.colors(t);
    const byId = Object.fromEntries(view.nodes.map((n) => [n.id, n]));

    // 작업이 바뀌거나, 지금 일어나는 곳이 바뀌거나, 계획의 모양이 바뀌면 다시 맞춘다
    const live = view.nodes.filter((n) => n.status === "doing" || n.status === "waiting" || n.status === "blocked").map((n) => n.id).join(",");
    const focus = `${view.work}|${live}|${L.width}x${L.height}|${L.nodes.length}`;
    if (this.canvasSize && this.focusKey !== focus) {
      this.focusKey = focus;
      this.centerOn(view);
    }
    const z = this.zoom;
    const X = (x) => this.pan.x + x * z, Y = (y) => this.pan.y + y * z;
    const cw = this.canvasSize?.width ?? 900, ch = this.canvasSize?.height ?? 300;

    // 선: 끝난 노드에서 나가는 선은 진하게, 나머지는 옅게. 끝에 화살촉
    const paths = [], dots = [];
    for (const e of L.edges) {
      const passed = byId[e.from]?.status === "done";
      const color = passed ? tint(c.done, 0.8) : t.input;
      const pts = e.points.map(([x, y]) => [X(x), Y(y)]);
      const [ex, ey] = pts[pts.length - 1], [qx, qy] = pts[pts.length - 2];
      const len = Math.hypot(ex - qx, ey - qy) || 1;
      const ux = (ex - qx) / len, uy = (ey - qy) / len;
      const ah = 6.5 * z, aw = 3.6 * z;
      const body = [...pts.slice(0, -1), [ex - ux * ah * 0.7, ey - uy * ah * 0.7]];
      paths.push({ path: roundPath(PathBuilder.stroke((passed ? 1.8 : 1.3) * Math.max(0.8, z)), body, 8 * z).build(), color });
      paths.push({
        path: PathBuilder.fill().add_polygon([[ex - ux * ah - uy * aw, ey - uy * ah + ux * aw], [ex, ey], [ex - ux * ah + uy * aw, ey - uy * ah - ux * aw]], true).build(),
        color,
      });
      dots.push({ x: pts[0][0], y: pts[0][1], color: passed ? color : t.muted });
    }

    const glows = [], cards = [];
    for (const p of L.nodes) {
      const n = byId[p.id];
      if (!n) continue;
      const x = X(p.x), y = Y(p.y), w = p.w * z, h = p.h * z;
      if (x > cw || y > ch || x + w < 0 || y + h < 0) continue; // 화면 밖은 그리지 않는다
      // 하던 세션이 닫힌 노드는 눈에 띄게 그리지 않는다. 지금 일어나는 일이 아니다
      const color = n.closed ? t.muted : c[n.status];
      const active = !n.closed && (n.status === "doing" || n.status === "waiting" || n.status === "blocked");
      const picked = this.node === n.id;
      if (active) {
        glows.push(div().absolute().left(x - 6 * z).top(y - 6 * z).w(w + 12 * z).h(h + 12 * z).rounded(12 * z).bg(color)
          .loop("opacity", { from: 0.05, to: n.status === "doing" ? 0.2 : 0.28, period: n.status === "doing" ? 1200 : 1800 }));
      }
      const read = n.skills.filter((s) => s.state === "read").length;
      const meta = this.metaOf(view, n, now);
      const tag = this.tagOf(n);
      const chip = (text, tone, faint) => div().flex_none().px(4.5 * z).rounded(4 * z).border(1).border_color(tint(tone, faint ? 0.3 : 0.6))
        .text_size(9.5 * z).text_color(faint ? tint(tone, 0.7) : tone).child(text);
      cards.push(h_flex().id(`node-${n.id}`).absolute().left(x).top(y).w(w).h(h).px(11 * z).gap(9 * z).items_center().rounded(8 * z)
        .bg(active ? tint(color, 0.12) : t.raised)
        .border(active || picked ? 1.5 : 1)
        .border_color(picked ? t.accent : active ? tint(color, 0.9) : n.status === "done" ? t.input : t.border)
        .cursor_pointer()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        // 누르면 그 노드의 기록을 본다. 두 번 누르면 그 노드를 하는 세션의 터미널로 간다.
        // 작업의 기록은 위의 "작업" 탭이나 그래프의 빈 곳을 눌러서 본다 (다시 눌러 고르기를 풀지 않는다: 두 번 누르기와 겹친다)
        .on_click((e, cx) => {
          this.node = n.id;
          this.tab = "node";
          this.drawer = true;
          if ((e?.click_count ?? 1) >= 2) this.goNode(view, n);
          cx.notify();
        })
        .child(this.statusIcon(t, n, color, 17 * z))
        .child(v_flex().flex_1().min_w(0).gap(2 * z)
          .child(h_flex().gap(5 * z).items_center()
            .child(div().flex_1().min_w(0).truncate().text_size(12.5 * z).text_color(n.status === "todo" ? t.muted : t.foreground)
              .when(active, (el) => el.font_semibold()).child(n.title))
            // 다시 한 노드는 눈에 띄게: 여기서 뭔가 걸렸다는 신호다
            .when(n.attempts > 1, (el) => el.child(chip(`${n.attempts}회차`, t.accent, false)))
            .when(Boolean(tag), (el) => el.child(chip(tag.text, t.muted, tag.planned)))
            .when(Boolean(n.offPlan), (el) => el.child(chip("≠계획", t.blocked, false)))
            // 앞 노드가 끝나기 전에 시작했다: 그래프 흐름과 다르게 진행 중이라는 표시
            .when(Boolean(n.early), (el) => el.child(chip("순서 앞당김", t.muted, false))))
          .child(h_flex().gap(6 * z).items_center().text_size(10.5 * z)
            .child(div().flex_1().min_w(0).truncate().text_color(active ? color : t.dim).child(meta || " "))
            .when(n.flags.length > 0, (el) => el.child(div().flex_none().text_color(t.blocked).child("⚑")))
            .when(read > 0, (el) => el.child(div().flex_none().text_color(t.dim).child(`skill ${read}`))))));
    }
    const ports = dots.map((d) => div().absolute().left(d.x - 3 * z).top(d.y - 3 * z).size(6 * z)
      .rounded_full().bg(d.color).border(1.5).border_color(t.canvas));

    const button = (id, label, act) => h_flex().id(id).h(26).px(9).items_center().rounded(6).bg(t.surface).border_1().border_color(t.border)
      .text_size(11).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { act(); cx.notify(); })
      .child(label);
    const controls = h_flex().absolute().right(12).bottom(12).gap(6)
      .child(button("c-now", "◎ 지금", () => { this.centerOn(view); }))
      .child(button("c-fit", "⤢ 전체", () => { this.fit(view); }))
      .child(button("c-out", "−", () => { this.zoomBy(1 / 1.2, { x: cw / 2, y: ch / 2 }, L); }))
      .child(button("c-in", "+", () => { this.zoomBy(1.2, { x: cw / 2, y: ch / 2 }, L); }));

    const layer = paths.map((q) => window.paint_path(q.path, q.color).absolute().left(0).top(0).w(cw).h(ch));
    return div().id("canvas").relative().flex_1().min_h(0).overflow_hidden().bg(t.canvas)
      .on_size_change((size, cx) => {
        const old = this.canvasSize;
        if (!old || Math.abs(old.width - size.width) > 1 || Math.abs(old.height - size.height) > 1) {
          this.canvasSize = { width: size.width, height: size.height };
          this.focusKey = null; // 크기가 바뀌면 다시 맞춘다
          // 칸이 가로로 길다가 세로로 길어졌으면(또는 반대) 흐름 방향을 바꿔 다시 읽는다
          if (this.loadedDown !== null && this.wantsDown() !== this.loadedDown) this.stale = true;
          cx.notify();
        }
      })
      .when(Boolean(this.press), (el) => el.cursor_grabbing())
      .when(!this.press, (el) => el.cursor_grab())
      .on_mouse_down("left", (e, cx) => { this.press = { x: e.position.x, y: e.position.y, px: this.pan.x, py: this.pan.y, moved: false }; cx.notify(); })
      .on_mouse_move((e, cx) => {
        if (!this.press) return;
        if (Math.abs(e.position.x - this.press.x) + Math.abs(e.position.y - this.press.y) > 3) this.press.moved = true;
        this.pan = { x: this.press.px + e.position.x - this.press.x, y: this.press.py + e.position.y - this.press.y };
        this.clampPan(L);
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => {
        // 끌지 않고 빈 곳을 눌렀다: 고른 노드를 풀고 작업 기록을 보여 준다
        if (this.press && !this.press.moved && (this.node || this.tab !== "work")) {
          this.node = null;
          this.tab = "work";
        }
        this.press = null;
        cx.notify();
      })
      .on_hover((hovered, cx) => { if (!hovered && this.press) { this.press = null; cx.notify(); } })
      .on_scroll_wheel((e, cx) => {
        if (e.modifiers.platform || e.modifiers.control) {
          const local = e.local_position ?? { x: cw / 2, y: ch / 2 };
          // 휠을 위로 굴리면 확대, 아래로 굴리면 축소 (브라우저·지도와 같은 방향)
          this.zoomBy(Math.exp(Math.max(-60, Math.min(60, e.delta.y)) * 0.004), local, L);
        } else {
          this.pan = { x: this.pan.x + e.delta.x, y: this.pan.y + e.delta.y };
          this.clampPan(L);
        }
        cx.notify();
      })
      .children([...layer, ...glows, ...cards, ...ports, controls]);
  }

  /**
   * 기록 칸: 위에 "작업 · 노드" 탭, 그 아래에 고른 탭의 기록.
   * 넓은 칸은 그래프 오른쪽에 늘 펴 두고, 좁은 칸(그래프 칸을 오른쪽에 뒀을 때)은 그래프 아래에 탭만 두었다가 누르면 편다
   */
  detailPane(t, view, now, foldable) {
    const open = !foldable || this.drawer;
    const tab = (id, text) => {
      const on = open && this.tab === id;
      return div().id(`tab-${id}`).h(22).px(10).flex().items_center().rounded(5).text_size(11)
        .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.dim)
        .cursor_pointer().hover((s) => s.bg(on ? t.selected : t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          // 좁은 칸에서 보고 있는 탭을 다시 누르면 접는다
          if (foldable && on) this.drawer = false;
          else {
            this.tab = id;
            this.drawer = true;
          }
          cx.notify();
        })
        .child(text);
    };
    const strip = h_flex().id("detail-tabs").flex_none().h(36).px(10).gap(8).items_center()
      .when(open, (el) => el.border_b(1).border_color(t.border))
      .child(h_flex().flex_none().gap(2).p(2).items_center().rounded(7).border_1().border_color(t.border).bg(t.chrome)
        .child(tab("work", "작업"))
        .child(tab("node", "노드")))
      .child(div().flex_1())
      .when(foldable, (el) => el.child(div().id("detail-fold").h(22).px(8).flex().items_center().rounded(5)
        .text_size(10.5).text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { this.drawer = !open; cx.notify(); })
        .child(open ? "접기 ▾" : "펴기 ▴")));
    return v_flex().size_full().min_h(0)
      .child(strip)
      .when(open, (el) => el.child(div().flex_1().min_h(0).child(this.detail(t, view, now))));
  }

  /** 기록: 작업 탭이면 시킨 말과 계획이 바뀐 기록, 노드 탭이면 고른 노드 */
  detail(t, view, now) {
    const c = this.colors(t);
    const n = this.tab === "node" && this.node ? view.nodes.find((x) => x.id === this.node) : null;
    const label = (text) => div().text_size(10).font_semibold().text_color(t.dim).child(text);
    const line = (text, color) => div().text_size(11.5).text_color(color ?? t.muted).child(text);
    const box = v_flex().id("detail").size_full().min_h(0).overflow_y_scrollbar().p(14).gap(10);

    if (this.tab === "node" && !n) return box.child(line("그래프에서 노드를 누르면 그 노드의 기록이 보여요", t.dim));
    if (!n) {
      const changes = view.changes.filter((ch) => !ch.first).slice(-6).reverse();
      const loose = view.flags.filter((f) => !f.node);
      return box
        .when(Boolean(view.request), (el) => el.child(v_flex().gap(3).child(label("시킨 말")).child(line(view.request, t.foreground))))
        .child(v_flex().gap(4).child(label("계획이 바뀐 기록"))
          .when(changes.length === 0, (el) => el.child(line("처음 계획 그대로예요", t.dim)))
          .children(changes.map((ch) => v_flex().gap(1)
            .child(h_flex().gap(6).text_size(10.5)
              .child(div().text_color(t.dim).child(clock(ch.at)))
              .child(div().text_color(ch.by === "human" ? t.accent : t.dim).child(ch.by === "human" ? "사람" : "AI"))
              .child(div().flex_1().min_w(0).truncate().text_color(t.muted)
                .child([...ch.added.map((id) => `+${id}`), ...ch.removed.map((id) => `−${id}`), ...ch.changed.map((id) => `~${id}`)].join(" "))))
            .child(line(ch.why ?? "(이유 없음)")))))
        .when((view.gone ?? []).length > 0, (el) => el.child(v_flex().gap(3).child(label("빠진 노드"))
          .children(view.gone.map((g) => line(`${g.title} (${STATUS_NAME[g.status] ?? g.status}) · ${g.why ?? "이유 없음"}`)))))
        .when(view.outside.length > 0, (el) => el.child(v_flex().gap(3).child(label("노드 밖에서 읽은 skill"))
          .child(line([...new Set(view.outside.map((s) => s.skill))].join(", ")))))
        .when(loose.length > 0, (el) => el.child(v_flex().gap(3).child(label("문제 표시"))
          .children(loose.map((f) => line(`⚑ ${f.text}`, t.blocked)))))
        .when(view.state === "stalled", (el) => el.child(v_flex().gap(8).child(label("이어서 하려면"))
          .child(div().text_size(10.5).text_color(t.dim).child("하던 세션이 모두 닫혔어요"))
          .child(this.openRow(t, "continue-work", "새 대화로 이어 가기", "muwi 기록(계획·결과)을 읽고 멈춘 노드부터 이어 가요", ["claude", `${view.work} 작업 이어서 해줘`],
            this.folderOk(view, view.cwd) ? view.cwd : null, view.work))
          .when(Boolean(view.cwd), (el2) => el2.child(div().text_size(10.5).text_color(t.dim).child(this.folderOk(view, view.cwd)
            ? `누르면 ${this.shortPath(view.cwd)}에서 새 탭으로 열려요` : `작업 폴더(${this.shortPath(view.cwd)})가 없어져서 기본 폴더에서 새 탭으로 열려요`)))));
    }

    const color = n.closed ? t.muted : c[n.status];
    const agent = this.agentOf(view, n);
    const terminal = this.terminalOf(view, n);
    const sessionName = (key) => {
      const i = key ? view.sessions?.[key] : null;
      return `${i?.label ?? ""}${i?.tool && i.tool !== "unknown" ? ` (${i.tool})` : ""}`;
    };
    /** 회차를 누가 했는지 한 줄 */
    const whoOf = (who) => {
      const count = (list) => {
        const kinds = [...new Set(list.map((a) => a.kind).filter(Boolean))].join(", ");
        return `서브에이전트 ${list.length}개${kinds ? ` (${kinds})` : ""}`;
      };
      const own = who.agents.filter((a) => a.own);
      const helped = who.agents.filter((a) => !a.own);
      if (who.kind === "subagent") return own.length ? count(own) : `${count(helped)} · 세션 ${view.sessions?.[who.session]?.label ?? ""}이 시작함`;
      const base = who.kind === "session" ? `새 세션 ${sessionName(who.session)}` : `세션 ${sessionName(who.session)}`;
      return [base, own.length ? count(own) : null, helped.length ? `${count(helped)}가 도움` : null].filter(Boolean).join(" + ");
    };
    // 실제로 한 쪽. 시작 전이면 뜨는 중인 세션
    const whoText = n.who ? whoOf(n.who) : n.spawn ? `새 세션 ${n.spawn.terminal} · ${this.alive(n.spawn.terminal) ? "뜨는 중" : "일을 시작하기 전에 닫힘"}` : null;
    const plannedText = n.run ? `계획: ${RUN_NAME[n.run] ?? n.run}${n.show ? `, ${n.show}` : ""}` : null;
    /**
     * 한 회차(또는 한 번만 한 노드)의 읽은 skill.
     * "읽은 skill이 없어요"는 훅이 보고 있었는데 읽지 않았을 때만 쓴다. 보지 못했으면 그렇게 적는다.
     */
    const skillRows = (x) => {
      const read = x.skills.filter((s) => s.state === "read");
      const loaded = x.skills.filter((s) => s.state === "loaded");
      const rows = [];
      if (x.seen === false) rows.push(line("읽은 skill을 볼 수 없었어요 (이 세션에서 훅이 돌지 않았어요)", t.blocked));
      else if (read.length === 0) rows.push(line(x.instant ? "시작과 끝을 한꺼번에 적어서 하는 동안의 기록이 없어요" : "하는 동안 읽은 skill이 없어요", t.dim));
      for (const s of read) {
        rows.push(h_flex().gap(6).items_start()
          .child(div().size(6).mt(5).flex_none().rounded_full().bg(t.done))
          .child(line(`${s.skill}${s.count > 1 ? ` ×${s.count}` : ""}${s.via === "file" ? " (파일을 직접 읽음)" : ""}${s.agent ? " · 서브에이전트가 읽음" : ""}${s.guess ? " · 확실하지 않음" : ""}`, t.foreground).flex_1().min_w(0)));
      }
      if (loaded.length > 0) {
        rows.push(div().pt(2).text_size(10).text_color(t.dim).child("이미 읽은 상태 (같은 세션이 앞에서 읽음)"));
        for (const s of loaded) {
          rows.push(h_flex().gap(6).items_start()
            .child(div().size(6).mt(5).flex_none().rounded_full().border(1).border_color(t.muted))
            .child(line(s.skill).flex_1().min_w(0)));
        }
      }
      return rows;
    };
    const tries = n.tries ?? [];
    const running = n.status === "doing" && !n.closed;
    // 하던 세션의 터미널이 닫혔으면 그 세션에 맞춰 이어 하는 방법을 보여 준다
    const resume = n.closed || (terminal && !this.alive(terminal)) ? this.resumeHints(t, view, n) : { rows: [], choices: 0 };
    const times = [
      n.startedAt ? `${clock(n.startedAt)} 시작` : null,
      n.spentMs > 0 ? `${dur(this.spent(n.spentMs, running, now))} 작업` : null,
      n.attempts > 1 ? `${n.attempts}회차` : null,
    ].filter(Boolean).join(" · ");
    return box
      .child(v_flex().gap(4)
        .child(div().text_size(13).font_semibold().child(n.title))
        .child(h_flex().gap(6).items_center()
          .child(this.pill(t, n.closed ? `멈춤 · ${STATUS_NAME[n.status]}이던 중` : STATUS_NAME[n.status], n.status === "todo" ? t.muted : color))
          .child(div().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(n.id))))
      .when(Boolean(n.closed), (el) => el.child(v_flex().gap(3).child(label("세션이 닫힘"))
        .child(line("이 노드를 하던 세션이 닫혔어요. 일이 끝났는지는 알 수 없어요. 이어서 하는 방법은 아래에 있어요."))))
      .when(Boolean(n.note), (el) => el.child(v_flex().gap(3)
        .child(label({ waiting: "기다리는 것", blocked: "막힌 이유", done: "결과" }[n.status] ?? "메모"))
        .child(line(n.note, n.status === "done" ? t.foreground : color))))
      .when(Boolean(times), (el) => el.child(v_flex().gap(3).child(label("시간")).child(line(times))))
      .when(Boolean(whoText || plannedText), (el) => el.child(v_flex().gap(4).child(label("누가"))
        // 글이 길면 줄을 바꾸고, 버튼은 그 아래에 둔다 (칸이 좁아도 잘리지 않게)
        .when(Boolean(whoText), (el) => el.child(line(`${whoText}${agent ? ` · ${AGENT_NAME[agent.status] ?? agent.status}` : ""}`, t.foreground)))
        // 터미널이 떠 있을 때만 갈 수 있다. 닫혔으면 버튼 대신 닫혔다고 적는다 (누르면 앱이 오류를 낸다)
        .when(Boolean(whoText && terminal) && this.alive(terminal), (el) => el.child(h_flex().child(
          h_flex().id(`go-${n.id}`).h(20).px(7).flex_none().items_center().rounded(5).bg(t.raised).border_1().border_color(t.border)
            .text_size(10.5).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
            // pane이 있으면 그 pane으로 가고, pane 없이 떠 있는 세션이면 그 자리에서 들여다본다
            .on_click(() => this.go(terminal))
            .child("터미널로 가기"))))
        .when(Boolean(whoText && terminal) && !this.alive(terminal), (el) => el.child(line("터미널이 닫혔어요", t.dim)))
        .when(Boolean(plannedText), (el) => el.child(line(
          n.offPlan ? `${plannedText} · 계획과 다르게 했어요`
            : n.runUnknown ? `${plannedText} · 이 세션에서 훅이 돌지 않아 계획대로 했는지 확인하지 못했어요` : plannedText,
          n.offPlan ? t.blocked : t.dim)))))
      .when(resume.choices > 0, (el) => el.child(v_flex().gap(8).child(label(n.status === "done" ? "그 대화를 다시 열려면" : resume.choices > 1 ? "이어서 하려면 (둘 중 하나)" : "이어서 하려면")).children(resume.rows)))
      .child(v_flex().gap(4).child(label(tries.length > 1 ? "회차별 기록" : "읽은 skill"))
        .when(n.attempts === 0, (el) => el.child(line("아직 시작하지 않았어요", t.dim)))
        .children(tries.length > 1
          ? tries.map((x) => v_flex().gap(3).pt(2)
            .child(h_flex().gap(6).items_center()
              .child(div().flex_none().px(5).rounded(4).border(1).border_color(tint(t.accent, 0.6)).text_size(10).text_color(t.accent).child(`${x.n}회차`))
              .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim)
                .child([x.startedAt ? clock(x.startedAt) : null, x.spentMs > 0 ? dur(this.spent(x.spentMs, running && x === tries[tries.length - 1], now)) : null, x.who ? whoOf(x.who) : null].filter(Boolean).join(" · "))))
            .children(skillRows(x))
            .when(Boolean(x.note), (el) => el.child(line(`${{ waiting: "기다린 것", blocked: "막힌 이유", done: "결과" }[x.status] ?? "메모"}: ${x.note}`))))
          : n.attempts > 0 ? skillRows(n) : []))
      .when(Boolean(n.spawn?.task), (el) => el.child(v_flex().gap(3).child(label("맡긴 말")).child(line(n.spawn.task))))
      .when(n.flags.length > 0, (el) => el.child(v_flex().gap(3).child(label("문제 표시"))
        .children(n.flags.map((f) => line(`⚑ ${f.text} (${ago(f.at, now)})`, t.blocked)))));
  }
}
