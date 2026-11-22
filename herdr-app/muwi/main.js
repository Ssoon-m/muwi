// muwi 그래프 칸 (Herdr 앱 mod).
// AI가 적은 작업 계획과 진행 기록을 `muwi board`로 읽어 그린다. 읽기만 한다: 기록도 세션도 바꾸지 않는다.
//   왼쪽: 작업 목록 (나를 기다리는 작업이 위)
//   가운데: 고른 작업의 그래프. 카드와 선의 좌표는 `muwi board`가 ELK로 계산해서 준다. 기록이 바뀌면 전체를 다시 그린다
//   오른쪽: 고른 노드의 기록 (맡은 세션, 걸린 시간, 읽은 skill, 문제 표시) 또는 작업의 기록 (계획이 바뀐 이유)
// 끌어서 옮기고, cmd/ctrl+스크롤로 확대한다. 지금 일어나는 곳(작업 중, 나를 기다림)이 보이게 따라간다.
import { View, div, svg, PathBuilder } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, home, theme, watchFolder, checking, shared, setShared, agents, panes, run, props as blockProps } from "herdr";

const SELECTED = "muwi.selected";
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const STATE_NAME = { waiting: "나를 기다림", blocked: "막힘", doing: "작업 중", done: "끝", idle: "노드 사이" };
const STATUS_NAME = { todo: "아직", doing: "작업 중", waiting: "나를 기다림", blocked: "막힘", done: "끝" };
const AGENT_NAME = { working: "세션 작업 중", blocked: "세션이 입력을 기다림", done: "세션이 멈춤", idle: "세션이 멈춤" };
const RUN_NAME = { me: "직접", subagent: "서브에이전트", session: "새 세션" };

function ago(iso, now) {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.round(s / 60)}분 전`;
  if (s < 86400) return `${Math.round(s / 3600)}시간 전`;
  return `${Math.round(s / 86400)}일 전`;
}

function dur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
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
    node("pr", "PR 올리기", "waiting", 588, { note: "PR 올릴까요?", seen: false, flags: [{ at: "2026-01-01T00:00:00.000Z", text: "견본" }] }),
  ];
  const work = {
    work: "sample", title: "견본 작업", request: "견본", state: "waiting", updatedAt: "2026-01-01T00:00:00.000Z",
    counts: { total: 3, todo: 0, doing: 1, waiting: 1, blocked: 0, done: 1 },
  };
  return {
    works: [{ ...work, active: [{ id: "pr", title: "PR 올리기", status: "waiting", note: "PR 올릴까요?" }] }],
    errors: [],
    selected: {
      ...work, nodes, edges: [], outside: [], compacts: [], flags: [], lead: "s1", helpers: { sessions: 1, subagents: 2 },
      gone: [{ at: "2026-01-01T00:00:00.000Z", id: "lint", title: "lint", status: "todo", why: "견본" }],
      changes: [{ at: "2026-01-01T00:00:00.000Z", by: "human", why: "견본", first: false, added: ["pr"], removed: [], changed: [] }],
      sessions: { s1: { label: "t1", tool: "claude", terminal: "t1" } },
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
 *   full (기본): 작업 목록 + 그래프 + 기록
 *   list:        작업 목록만 (사이드바)
 *   graph:       그래프와 기록만 (목록은 다른 칸에서 고른다)
 * 고른 작업은 shared 상태로 칸끼리 나눠 쓴다. props.work를 주면 그 작업에 고정한다.
 */
export default class Muwi extends View {
  init(_props, cx) {
    this.data = null;
    this.error = null;
    this.selected = null;
    this.node = null;
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
    if (checking()) {
      this.data = SAMPLE;
      this.node = "impl";
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
      }
    });
  }

  variant() {
    const v = (blockProps() ?? {}).variant;
    return v === "list" || v === "graph" ? v : "full";
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
    cx.spawn(async (cx) => {
      try {
        const want = this.wanted();
        const args = want ? ["board", "--work", String(want)] : ["board"];
        const r = await exec(`${home()}/.local/bin/muwi`, args, { timeout: 20000 });
        if (r.code !== 0) throw new Error(r.stderr.trim() || `muwi가 ${r.code}로 끝났어요`);
        const data = JSON.parse(r.stdout);
        // 고른 작업이 없어졌으면 맨 위 작업으로
        if (want && !data.selected && data.works.length) {
          this.selected = null;
          if (!this.pinned()) setShared(SELECTED, null);
          this.again = true;
        }
        this.data = data;
        this.error = null;
        if (this.node && !data.selected?.nodes.some((n) => n.id === this.node)) this.node = null;
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

  select(work, cx) {
    this.selected = work;
    this.node = null;
    this.focusKey = null;
    if (!this.pinned()) setShared(SELECTED, work);
    this.load(cx);
  }

  colors(t) {
    // 나를 기다림은 Herdr가 "사람이 필요함"에 쓰는 색, 막힘은 그와 구별되는 색
    return { todo: t.input, doing: t.working, waiting: t.blocked, blocked: t.ansi5 ?? t.blocked, done: t.done, idle: t.muted };
  }

  render(_cx) {
    const t = theme();
    const now = Date.now();
    const variant = this.variant();
    const works = this.data?.works ?? [];
    // 다른 칸에서 작업을 바꿨으면 따라간다
    const want = this.wanted();
    const view = this.data?.selected ?? null;
    if (!checking() && want && view && view.work !== want && !this.loading) this.stale = true;
    const root = v_flex().id("root").size_full().min_h(0).text_color(t.foreground).text_size(12)
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.size.width) > 1 || Math.abs(size.height - this.size.height) > 1) {
          this.size = { width: size.width, height: size.height };
          cx.notify();
        }
      });

    if (variant === "list") {
      return root.bg(t.chrome)
        .child(this.listHead(t, works))
        .when(Boolean(this.error), (el) => el.child(this.problem(t)))
        .when(!this.error && this.data !== null && works.length === 0, (el) => el.child(this.empty(t)))
        .when(works.length > 0, (el) => el.child(this.list(t, works, view?.work, now, true)));
    }

    const wide = this.size.width >= 1040;
    const showList = variant === "full" && this.size.width >= 720 && !this.pinned();
    const body = h_flex().flex_1().min_h(0)
      .when(showList, (el) => el.child(
        v_flex().w(236).flex_none().h_full().min_h(0).bg(t.chrome).border_r(1).border_color(t.border)
          .child(this.listHead(t, works))
          .child(this.list(t, works, view?.work, now, true))))
      .child(v_flex().flex_1().min_w(0).h_full().min_h(0)
        .when(!showList && variant === "full" && works.length > 1 && !this.pinned(), (el) => el.child(this.chips(t, works, view?.work)))
        .child(view ? this.canvas(t, view, now) : div().flex_1())
        .when(Boolean(view) && !wide && Boolean(this.node), (el) => el.child(
          div().flex_none().h(150).border_t(1).border_color(t.border).bg(t.surface).child(this.detail(t, view, now)))))
      .when(Boolean(view) && wide, (el) => el.child(
        div().w(300).flex_none().h_full().min_h(0).border_l(1).border_color(t.border).bg(t.surface).child(this.detail(t, view, now))));

    return root.bg(t.canvas)
      .child(this.head(t, view, works, now))
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
    const legend = (text, color) => h_flex().gap(5).items_center()
      .child(div().size(8).rounded_full().bg(color))
      .child(div().text_size(10.5).text_color(t.dim).child(text));
    return h_flex().flex_none().h(44).px(16).gap(10).items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(h_flex().gap(8).items_center()
          .child(div().min_w(0).truncate().text_size(13).font_semibold().child(view ? (view.title ?? view.work) : "작업 그래프"))
          .when(Boolean(view), (el) => el.child(this.pill(t, STATE_NAME[view.state] ?? view.state, c[view.state] ?? t.muted))))
        .child(div().truncate().text_size(10.5).text_color(t.dim).child(
          view ? [`${view.work} · ${view.counts.done}/${view.counts.total} 끝 · ${ago(view.updatedAt, now)}`,
            view.helpers?.sessions ? `새 세션 ${view.helpers.sessions}` : null,
            view.helpers?.subagents ? `서브에이전트 ${view.helpers.subagents}` : null].filter(Boolean).join(" · ") : `${works.length}개 작업`)))
      .when(this.size.width >= 860, (el) => el.child(h_flex().flex_none().gap(12)
        .child(legend("작업 중", c.doing)).child(legend("나를 기다림", c.waiting)).child(legend("막힘", c.blocked)).child(legend("끝", c.done))));
  }

  listHead(t, works) {
    const waiting = works.filter((w) => w.state === "waiting").length;
    const running = works.filter((w) => w.state === "doing").length;
    return h_flex().px(14).h(36).flex_none().items_center().gap(6)
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
      .child(div().text_color(t.dim).child("Claude Code 세션에서 muwi setup을 실행하면 ~/.local/bin/muwi가 생겨요."));
  }

  empty(t) {
    return v_flex().p(16).gap(6)
      .child(div().text_color(t.muted).child("기록된 작업이 없어요."))
      .child(div().text_color(t.dim).text_size(11).child("에이전트에게 일을 시키면, 에이전트가 짠 계획이 여기에 그려져요."));
  }

  workMark(t, w, c) {
    if (w.state === "doing") return div().w(14).flex_none().text_color(c.doing).frames(SPIN, 90);
    const mark = { waiting: "⏸", blocked: "✗", done: "✓", idle: "○" }[w.state] ?? "•";
    return div().w(14).flex_none().text_color(c[w.state] ?? t.muted).child(mark);
  }

  /** 작업 목록: 제목 / 지금 눈여겨볼 노드 한 줄 */
  list(t, works, selected, now, fill) {
    const c = this.colors(t);
    const box = fill ? v_flex().flex_1().min_h(0) : v_flex().flex_none();
    return box.id("works").overflow_y_scrollbar().px(8).pb(8).gap(2)
      .children(works.map((w) => {
        const on = w.work === selected;
        const first = w.active.find((n) => n.status === "waiting") ?? w.active.find((n) => n.status === "blocked") ?? w.active[0];
        const line = w.state === "done" ? "모든 노드가 끝났어요"
          : first ? `${first.title}${first.note ? ` · ${first.note}` : ""}` : `${w.counts.done}/${w.counts.total} 끝`;
        return h_flex().id(`work-${w.work}`).px(8).py(6).gap(8).items_center().rounded(7)
          .bg(on ? t.selected : t.chrome).hover((s) => s.bg(on ? t.selected : t.hover)).cursor_pointer()
          .on_click((_e, cx) => this.select(w.work, cx))
          .child(this.workMark(t, w, c))
          .child(v_flex().flex_1().min_w(0).gap(1)
            .child(div().truncate().text_size(12).text_color(on ? t.foreground : t.muted).when(on, (el) => el.font_medium()).child(w.title ?? w.work))
            .child(h_flex().gap(6).text_size(10.5)
              .child(div().flex_1().min_w(0).truncate().text_color(c[w.state] ?? t.dim).child(line))
              .child(div().flex_none().text_color(t.dim).child(ago(w.updatedAt, now)))));
      }));
  }

  /** 좁을 때는 목록 대신 한 줄로 */
  chips(t, works, selected) {
    const c = this.colors(t);
    return h_flex().id("chips").flex_none().h(34).px(10).gap(6).items_center().overflow_x_hidden().border_b(1).border_color(t.border)
      .children(works.slice(0, 8).map((w) => {
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
  metaOf(view, n) {
    const times = n.spentMs > 0 ? dur(n.spentMs) : null;
    if (n.status === "waiting" || n.status === "blocked") return n.note ?? STATUS_NAME[n.status];
    if (n.status === "doing") {
      const agent = this.agentOf(view, n);
      const quiet = agent && agent.status !== "working" ? AGENT_NAME[agent.status] : null;
      return [n.who?.kind === "subagent" ? "서브에이전트" : null, times, quiet].filter(Boolean).join(" · ") || "작업 중";
    }
    if (n.status === "done") return [times, n.note].filter(Boolean).join(" · ");
    if (n.spawn) {
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
    // 그래프가 화면에 다 들어오면 가운데에, 아니면 지금 일어나는 곳으로
    // 글자가 읽히지 않을 만큼 줄이지는 않는다. 넘치면 원래 크기로 두고 지금 일어나는 곳을 보여 준다
    const fit = Math.min(1, s.width / L.width, s.height / L.height);
    if (fit >= 0.9) {
      this.zoom = fit;
      this.pan = { x: (s.width - L.width * fit) / 2, y: Math.max(0, (s.height - L.height * fit) / 2) };
      return;
    }
    this.zoom = 1;
    const live = view.nodes.filter((n) => n.status === "doing" || n.status === "waiting" || n.status === "blocked").map((n) => n.id);
    const boxes = L.nodes.filter((p) => (live.length ? live.includes(p.id) : true));
    const x1 = Math.min(...boxes.map((p) => p.x)), x2 = Math.max(...boxes.map((p) => p.x + p.w));
    const y1 = Math.min(...boxes.map((p) => p.y)), y2 = Math.max(...boxes.map((p) => p.y + p.h));
    const clamp = (v, size, full) => (full <= size ? (size - full) / 2 : Math.min(0, Math.max(size - full, v)));
    this.pan = { x: clamp(s.width / 2 - (x1 + x2) / 2, s.width, L.width), y: clamp(s.height / 2 - (y1 + y2) / 2, s.height, L.height) };
  }

  fit(view) {
    const s = this.canvasSize;
    const L = view.layout;
    if (!s || !L.width) return;
    this.zoom = Math.max(0.3, Math.min(1.2, s.width / L.width, s.height / L.height));
    this.pan = { x: (s.width - L.width * this.zoom) / 2, y: Math.max(0, (s.height - L.height * this.zoom) / 2) };
  }

  zoomBy(f, point) {
    const next = Math.max(0.3, Math.min(1.6, this.zoom * f));
    const wx = (point.x - this.pan.x) / this.zoom, wy = (point.y - this.pan.y) / this.zoom;
    this.zoom = next;
    this.pan = { x: point.x - wx * next, y: point.y - wy * next };
  }

  canvas(t, view, _now) {
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
      const color = c[n.status];
      const active = n.status === "doing" || n.status === "waiting" || n.status === "blocked";
      const picked = this.node === n.id;
      if (active) {
        glows.push(div().absolute().left(x - 6 * z).top(y - 6 * z).w(w + 12 * z).h(h + 12 * z).rounded(12 * z).bg(color)
          .loop("opacity", { from: 0.05, to: n.status === "doing" ? 0.2 : 0.28, period: n.status === "doing" ? 1200 : 1800 }));
      }
      const read = n.skills.filter((s) => s.state === "read").length;
      const meta = this.metaOf(view, n);
      const tag = this.tagOf(n);
      const chip = (text, tone, faint) => div().flex_none().px(4.5 * z).rounded(4 * z).border(1).border_color(tint(tone, faint ? 0.3 : 0.6))
        .text_size(9.5 * z).text_color(faint ? tint(tone, 0.7) : tone).child(text);
      cards.push(h_flex().id(`node-${n.id}`).absolute().left(x).top(y).w(w).h(h).px(11 * z).gap(9 * z).items_center().rounded(8 * z)
        .bg(active ? tint(color, 0.12) : t.raised)
        .border(active || picked ? 1.5 : 1)
        .border_color(picked ? t.accent : active ? tint(color, 0.9) : n.status === "done" ? t.input : t.border)
        .cursor_pointer()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { this.node = this.node === n.id ? null : n.id; cx.notify(); })
        .child(this.statusIcon(t, n, color, 17 * z))
        .child(v_flex().flex_1().min_w(0).gap(2 * z)
          .child(h_flex().gap(5 * z).items_center()
            .child(div().flex_1().min_w(0).truncate().text_size(12.5 * z).text_color(n.status === "todo" ? t.muted : t.foreground)
              .when(active, (el) => el.font_semibold()).child(n.title))
            // 다시 한 노드는 눈에 띄게: 여기서 뭔가 걸렸다는 신호다
            .when(n.attempts > 1, (el) => el.child(chip(`${n.attempts}회차`, t.accent, false)))
            .when(Boolean(tag), (el) => el.child(chip(tag.text, t.muted, tag.planned)))
            .when(Boolean(n.offPlan), (el) => el.child(chip("≠계획", t.blocked, false))))
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
      .child(button("c-out", "−", () => { this.zoomBy(1 / 1.2, { x: cw / 2, y: ch / 2 }); }))
      .child(button("c-in", "+", () => { this.zoomBy(1.2, { x: cw / 2, y: ch / 2 }); }));

    const layer = paths.map((q) => window.paint_path(q.path, q.color).absolute().left(0).top(0).w(cw).h(ch));
    return div().id("canvas").relative().flex_1().min_h(0).overflow_hidden().bg(t.canvas)
      .on_size_change((size, cx) => {
        const old = this.canvasSize;
        if (!old || Math.abs(old.width - size.width) > 1 || Math.abs(old.height - size.height) > 1) {
          this.canvasSize = { width: size.width, height: size.height };
          this.focusKey = null; // 크기가 바뀌면 다시 맞춘다
          cx.notify();
        }
      })
      .when(Boolean(this.press), (el) => el.cursor_grabbing())
      .when(!this.press, (el) => el.cursor_grab())
      .on_mouse_down("left", (e, cx) => { this.press = { x: e.position.x, y: e.position.y, px: this.pan.x, py: this.pan.y }; cx.notify(); })
      .on_mouse_move((e, cx) => {
        if (!this.press) return;
        this.pan = { x: this.press.px + e.position.x - this.press.x, y: this.press.py + e.position.y - this.press.y };
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => { this.press = null; cx.notify(); })
      .on_hover((hovered, cx) => { if (!hovered && this.press) { this.press = null; cx.notify(); } })
      .on_scroll_wheel((e, cx) => {
        if (e.modifiers.platform || e.modifiers.control) {
          const local = e.local_position ?? { x: cw / 2, y: ch / 2 };
          this.zoomBy(Math.exp(Math.max(-60, Math.min(60, -e.delta.y)) * 0.004), local);
        } else {
          this.pan = { x: this.pan.x + e.delta.x, y: this.pan.y + e.delta.y };
        }
        cx.notify();
      })
      .children([...layer, ...glows, ...cards, ...ports, controls]);
  }

  /** 오른쪽 기록: 노드를 골랐으면 그 노드, 아니면 작업 */
  detail(t, view, now) {
    const c = this.colors(t);
    const n = this.node ? view.nodes.find((x) => x.id === this.node) : null;
    const label = (text) => div().text_size(10).font_semibold().text_color(t.dim).child(text);
    const line = (text, color) => div().text_size(11.5).text_color(color ?? t.muted).child(text);
    const box = v_flex().id("detail").size_full().min_h(0).overflow_y_scrollbar().p(14).gap(10);

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
        .child(line("노드를 누르면 그 노드의 기록이 보여요", t.dim));
    }

    const color = c[n.status];
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
    const whoText = n.who ? whoOf(n.who) : n.spawn ? `새 세션 ${n.spawn.terminal} · 뜨는 중` : null;
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
        rows.push(h_flex().gap(6).items_center()
          .child(div().size(6).flex_none().rounded_full().bg(t.done))
          .child(line(`${s.skill}${s.count > 1 ? ` ×${s.count}` : ""}${s.via === "file" ? " (파일을 직접 읽음)" : ""}${s.agent ? " · 서브에이전트가 읽음" : ""}${s.guess ? " · 확실하지 않음" : ""}`, t.foreground)));
      }
      if (loaded.length > 0) {
        rows.push(div().pt(2).text_size(10).text_color(t.dim).child("이미 읽은 상태 (같은 세션이 앞에서 읽음)"));
        for (const s of loaded) {
          rows.push(h_flex().gap(6).items_center()
            .child(div().size(6).flex_none().rounded_full().border(1).border_color(t.muted))
            .child(line(s.skill)));
        }
      }
      return rows;
    };
    const tries = n.tries ?? [];
    const times = [
      n.startedAt ? `${clock(n.startedAt)} 시작` : null,
      n.spentMs > 0 ? `${dur(n.spentMs)} 작업` : null,
      n.attempts > 1 ? `${n.attempts}회차` : null,
    ].filter(Boolean).join(" · ");
    return box
      .child(v_flex().gap(4)
        .child(div().text_size(13).font_semibold().child(n.title))
        .child(h_flex().gap(6).items_center()
          .child(this.pill(t, STATUS_NAME[n.status], n.status === "todo" ? t.muted : color))
          .child(div().text_size(10.5).text_color(t.dim).child(n.id))))
      .when(Boolean(n.note), (el) => el.child(v_flex().gap(3)
        .child(label({ waiting: "기다리는 것", blocked: "막힌 이유", done: "결과" }[n.status] ?? "메모"))
        .child(line(n.note, n.status === "done" ? t.foreground : color))))
      .when(Boolean(times), (el) => el.child(v_flex().gap(3).child(label("시간")).child(line(times))))
      .when(Boolean(whoText || plannedText), (el) => el.child(v_flex().gap(4).child(label("누가"))
        .when(Boolean(whoText), (el) => el.child(h_flex().gap(8).items_center()
          .child(line(`${whoText}${agent ? ` · ${AGENT_NAME[agent.status] ?? agent.status}` : ""}`, t.foreground))
          .when(Boolean(terminal), (el) => el.child(
            h_flex().id(`go-${n.id}`).h(20).px(7).flex_none().items_center().rounded(5).bg(t.raised).border_1().border_color(t.border)
              .text_size(10.5).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
              // pane이 있으면 그 pane으로 가고, pane 없이 떠 있는 세션이면 그 자리에서 들여다본다
              .on_click(() => run(panes().some((p) => p.terminal === terminal) ? "pane.focus" : "terminal.peek", { terminal }))
              .child("터미널로 가기")))))
        .when(Boolean(plannedText), (el) => el.child(line(n.offPlan ? `${plannedText} · 계획과 다르게 했어요` : plannedText, n.offPlan ? t.blocked : t.dim)))))
      .child(v_flex().gap(4).child(label(tries.length > 1 ? "회차별 기록" : "읽은 skill"))
        .when(n.attempts === 0, (el) => el.child(line("아직 시작하지 않았어요", t.dim)))
        .children(tries.length > 1
          ? tries.map((x) => v_flex().gap(3).pt(2)
            .child(h_flex().gap(6).items_center()
              .child(div().flex_none().px(5).rounded(4).border(1).border_color(tint(t.accent, 0.6)).text_size(10).text_color(t.accent).child(`${x.n}회차`))
              .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim)
                .child([x.startedAt ? clock(x.startedAt) : null, x.spentMs > 0 ? dur(x.spentMs) : null, x.who ? whoOf(x.who) : null].filter(Boolean).join(" · "))))
            .children(skillRows(x))
            .when(Boolean(x.note), (el) => el.child(line(`${{ waiting: "기다린 것", blocked: "막힌 이유", done: "결과" }[x.status] ?? "메모"}: ${x.note}`))))
          : n.attempts > 0 ? skillRows(n) : []))
      .when(Boolean(n.spawn?.task), (el) => el.child(v_flex().gap(3).child(label("맡긴 말")).child(line(n.spawn.task))))
      .when(n.flags.length > 0, (el) => el.child(v_flex().gap(3).child(label("문제 표시"))
        .children(n.flags.map((f) => line(`⚑ ${f.text} (${ago(f.at, now)})`, t.blocked)))));
  }
}
