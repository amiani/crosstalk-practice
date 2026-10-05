/* eslint-disable effecttsgo/async-function, effecttsgo/global-console, effecttsgo/global-date, effecttsgo/global-fetch, effecttsgo/global-timers, effecttsgo/new-promise -- The browser client is deliberately plain DOM and promise code; Effect is used only for the shared API schema and generated client. */
import {
  DEFAULT_PRACTICE_MODE,
  DEFAULT_PRACTICE_TRACK,
} from "../src/domain/model.ts";
import type {
  CurriculumProgress,
  PracticeItem,
  PracticeMode,
  PracticeTrack,
  PresentationEventDetail,
  SessionView,
} from "../src/domain/model.ts";
import * as api from "./api.ts";
import {
  acceptUpcoming,
  holdForReserve,
  keepCurrent,
  QUEUE_CAPACITY,
  RESUME_RESERVE,
  sameStream,
} from "./practiceQueue.ts";
import type { PracticeStream } from "./practiceQueue.ts";
import { PresentationOutbox, randomUuid } from "./presentationLog.ts";
import type { Presentation } from "./presentationLog.ts";
import { ResponseOutbox } from "./responseOutbox.ts";

// ---------------------------------------------------------------------------
// Tiny DOM helpers.
// ---------------------------------------------------------------------------

type Child = Node | string | null | undefined | false;

const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  ...children: ReadonlyArray<Child>
): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  const { class: className, ...rest } = props;
  if (className !== undefined) {
    el.className = className;
  }
  Object.assign(el, rest);
  for (const child of children) {
    if (child === null || child === undefined || child === false) {
      continue;
    }
    el.append(child);
  }
  return el;
};

const app = document.getElementById("app")!;

/** Bumped on every screen change so stale timers and callbacks stop. */
let screen = 0;

const show = (...children: ReadonlyArray<Child>): number => {
  screen += 1;
  app.replaceChildren(
    ...children.filter(
      (c): c is Node | string => c !== null && c !== undefined && c !== false,
    ),
  );
  return screen;
};

const sleep = async (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Practice track and mode selectors.
// ---------------------------------------------------------------------------

interface ChoiceOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly description: string;
}

/**
 * The learner-facing names of the tracks. They never mention concepts or
 * mastery: what is being taught stays behind the scenes, and only the
 * overall share of each curriculum understood is shown (see `Journey`).
 */
const trackOptions: ReadonlyArray<ChoiceOption<PracticeTrack>> = [
  {
    description:
      "Learn the small words and endings that hold Finnish sentences together, one idea at a time, using words from your conversation.",
    label: "Building blocks",
    value: "curriculum",
  },
  {
    description: "New sentences built from what you heard.",
    label: "Conversation",
    value: "crosstalk",
  },
];

const modeOptions: ReadonlyArray<ChoiceOption<PracticeMode>> = [
  {
    description: "Simple sentences with a single clause.",
    label: "Beginner",
    value: "beginner",
  },
  {
    description: "Any sentence structure, including longer sentences.",
    label: "Intermediate",
    value: "intermediate",
  },
];

let choiceControls = 0;

/** A labelled radio group; native radios keep it keyboard accessible. */
class Choice<T extends string> {
  public readonly element: HTMLFieldSetElement;
  private readonly inputs = new Map<T, HTMLInputElement>();
  private readonly fallback: T;

  public constructor(
    legend: string,
    options: ReadonlyArray<ChoiceOption<T>>,
    initial: T,
    onChange: (value: T) => void,
    status?: HTMLElement,
  ) {
    choiceControls += 1;
    const name = `practice-choice-${choiceControls}`;
    this.fallback = initial;
    this.element = h(
      "fieldset",
      { class: "mode" },
      h("legend", {}, legend),
      ...options.map((option) => {
        const input = h("input", {
          checked: option.value === initial,
          name,
          type: "radio",
          value: option.value,
        });
        input.addEventListener("change", () => {
          if (input.checked) {
            onChange(option.value);
          }
        });
        this.inputs.set(option.value, input);
        return h(
          "label",
          { class: "mode-option" },
          input,
          h(
            "span",
            {},
            h("strong", {}, option.label),
            h("span", { class: "mode-description" }, option.description),
          ),
        );
      }),
      status,
    );
  }

  public get value(): T {
    for (const [value, input] of this.inputs) {
      if (input.checked) {
        return value;
      }
    }
    return this.fallback;
  }

  public set value(value: T) {
    const input = this.inputs.get(value);
    if (input !== undefined) {
      input.checked = true;
    }
  }

  public set disabled(disabled: boolean) {
    this.element.disabled = disabled;
  }

  public set hidden(hidden: boolean) {
    this.element.hidden = hidden;
  }
}

const trackChoice = (
  initial: PracticeTrack,
  onChange: (track: PracticeTrack) => void,
  status?: HTMLElement,
) => new Choice("What to practice", trackOptions, initial, onChange, status);

const modeChoice = (
  initial: PracticeMode,
  onChange: (mode: PracticeMode) => void,
  status?: HTMLElement,
) => new Choice("Sentence level", modeOptions, initial, onChange, status);

/** The sentence level only applies to Conversation practice. */
const modeApplies = (track: PracticeTrack): boolean => track === "crosstalk";

// ---------------------------------------------------------------------------
// Presentation log (how each sentence was listened to) and curriculum
// answers, both delivered in the background and kept until stored.
// ---------------------------------------------------------------------------

const storage = (() => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
})();

const outbox = new PresentationOutbox({
  send: api.sendPresentationEvents,
  storage,
});
const responses = new ResponseOutbox({
  send: api.sendCurriculumResponse,
  storage,
});
// Deliver whatever an earlier visit could not.
void outbox.flush();
void responses.flush();

/** How long an answer may wait before the page says it is still saving. */
const SAVE_HINT_DELAY_MS = 4000;

document.addEventListener("visibilitychange", () => {
  const visible = document.visibilityState === "visible";
  practice?.visibilityChanged(visible);
  if (!visible) {
    outbox.flushOnExit();
    responses.flushOnExit();
  } else {
    void responses.flush();
    // The track or mode may have been changed in another tab meanwhile.
    void practice?.sync();
  }
});
window.addEventListener("pagehide", () => {
  outbox.flushOnExit();
  responses.flushOnExit();
});
window.addEventListener("online", () => {
  void outbox.flush();
  void responses.flush();
});

const knownErrors: Record<string, string> = {
  NoActiveSession: "There is no active session.",
  NotRetryable: "This step can't be retried. Try a new recording.",
  SessionAlreadyExists: "A session already exists.",
};

const errorText = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const known = knownErrors[String(error._tag)];
    if (known !== undefined) {
      return known;
    }
  }
  return error instanceof Error && error.message !== ""
    ? error.message
    : "Something went wrong.";
};

// ---------------------------------------------------------------------------
// Session routing.
// ---------------------------------------------------------------------------

let practice: Practice | undefined;

const refresh = async (): Promise<void> => {
  try {
    render(await api.currentSession());
  } catch (error) {
    renderConnectionError(error);
  }
};

const render = (view: SessionView): void => {
  if (view._tag !== "Ready") {
    practice?.dispose();
    practice = undefined;
  }
  switch (view._tag) {
    case "NoSession": {
      renderUpload();
      return;
    }
    case "Preparing": {
      renderPreparing(view.stage);
      return;
    }
    case "Failed": {
      renderFailed(view.failure);
      return;
    }
    case "Ready":
      if (practice === undefined || !practice.isMounted()) {
        practice?.dispose();
        practice = new Practice(view);
      } else {
        practice.updateSession(view);
      }
      return;
  }
};

/** Deletes this recording's session; Building blocks progress is kept. */
const newRecording = async (): Promise<void> => {
  if (
    !confirm(
      "Use a new recording?\n\nThis recording, the sentences made from it, their audio and your listening logs will be deleted.\n\nYour Building blocks progress is kept: what you've understood, and the text of those sentences.",
    )
  ) {
    return;
  }
  try {
    // Let the last answers count before their sentences go away.
    await Promise.race([responses.flush(), sleep(3000)]);
    await api.replaceRecording();
  } catch (error) {
    alert(errorText(error));
  }
  await refresh();
};

/** Deletes everything, including all Building blocks progress. */
const startOver = async (): Promise<void> => {
  if (
    !confirm(
      "Start over and delete everything?\n\nYour recording, its sentences and audio, your listening logs and all your Building blocks progress will be deleted. This can't be undone.",
    )
  ) {
    return;
  }
  try {
    await api.resetSession();
  } catch (error) {
    alert(errorText(error));
  }
  await refresh();
};

/** The two ways out of a session, as links or as buttons. */
const sessionActions = (style: "link" | "btn"): HTMLElement =>
  h(
    "div",
    { class: `session-actions ${style}s` },
    h(
      "button",
      { class: style, onclick: () => void newRecording() },
      "New recording (keep progress)",
    ),
    h(
      "button",
      { class: style, onclick: () => void startOver() },
      "Start over (delete everything)",
    ),
  );

const renderConnectionError = (error: unknown): void => {
  show(
    h(
      "section",
      { class: "card center" },
      h("h1", {}, "Can't reach the server"),
      h("p", { class: "muted" }, errorText(error)),
      h(
        "button",
        { class: "btn primary", onclick: () => void refresh() },
        "Try again",
      ),
    ),
  );
};

// ---------------------------------------------------------------------------
// Upload.
// ---------------------------------------------------------------------------

const renderUpload = (): void => {
  const input = h("input", {
    accept: "audio/*",
    class: "file",
    id: "recording",
    type: "file",
  });
  const fileLabel = h("span", { class: "file-name" }, "Choose a recording");
  const pick = h(
    "label",
    { class: "btn picker", htmlFor: "recording" },
    fileLabel,
  );
  const button = h(
    "button",
    { class: "btn primary", disabled: true },
    "Upload",
  );
  const status = h("p", { class: "status", role: "status" });
  const progress = h("progress", { hidden: true, max: 1, value: 0 });
  const mode = modeChoice(DEFAULT_PRACTICE_MODE, () => {});
  mode.hidden = !modeApplies(DEFAULT_PRACTICE_TRACK);
  const track = trackChoice(DEFAULT_PRACTICE_TRACK, (chosen) => {
    mode.hidden = !modeApplies(chosen);
  });

  input.addEventListener("change", () => {
    const file = input.files?.[0];
    fileLabel.textContent = file?.name ?? "Choose a recording";
    button.disabled = file === undefined;
    status.textContent = "";
    status.classList.remove("error");
  });

  const upload = async (): Promise<void> => {
    const file = input.files?.[0];
    if (file === undefined) {
      return;
    }
    button.disabled = true;
    input.disabled = true;
    mode.disabled = true;
    track.disabled = true;
    pick.classList.add("disabled");
    progress.hidden = false;
    progress.removeAttribute("value");
    status.classList.remove("error");
    status.textContent = "Uploading…";
    try {
      await api.uploadRecording(file, track.value, mode.value, (fraction) => {
        progress.value = fraction;
        status.textContent =
          fraction >= 1
            ? "Processing upload…"
            : `Uploading… ${Math.round(fraction * 100)}%`;
      });
      await refresh();
    } catch (error) {
      if (error instanceof api.UploadError && error.status === 409) {
        // A session appeared meanwhile (another tab?); show it.
        status.classList.add("error");
        status.textContent = errorText(error);
        await sleep(1500);
        return refresh();
      }
      progress.hidden = true;
      status.classList.add("error");
      status.textContent = errorText(error);
      button.disabled = false;
      input.disabled = false;
      mode.disabled = false;
      track.disabled = false;
      pick.classList.remove("disabled");
    }
  };
  button.addEventListener("click", () => void upload());

  show(
    h(
      "section",
      { class: "card" },
      h("h1", {}, "Crosstalk practice"),
      h(
        "p",
        { class: "muted" },
        "Upload a recording of a crosstalk conversation. You'll get an endless stream of Finnish sentences to listen to, built from its words.",
      ),
      input,
      pick,
      track.element,
      mode.element,
      button,
      progress,
      status,
      h("p", { class: "note" }, "Recordings up to about 30 minutes work best."),
    ),
  );
};

// ---------------------------------------------------------------------------
// Preparing / Failed.
// ---------------------------------------------------------------------------

const stageText: Record<string, string> = {
  analyzing: "Analyzing the conversation…",
  generating: "Generating the first sentences…",
  transcribing: "Transcribing the recording…",
};

const renderPreparing = (stage: string): void => {
  const token = show(
    h(
      "section",
      { class: "card center" },
      h("div", { ariaHidden: "true", class: "spinner" }),
      h("h1", {}, stageText[stage] ?? "Preparing…"),
      h(
        "p",
        { class: "muted" },
        "This can take a few minutes for long recordings.",
      ),
      sessionActions("link"),
    ),
  );
  void sleep(3000).then(() => {
    if (token === screen) {
      void refresh();
    }
  });
};

const renderFailed = (failure: {
  readonly message: string;
  readonly retryable: boolean;
}): void => {
  const status = h("p", { class: "status error", role: "status" });
  const retry = failure.retryable
    ? h("button", { class: "btn primary" }, "Retry")
    : null;
  const onRetry = async (button: HTMLButtonElement): Promise<void> => {
    button.disabled = true;
    try {
      render(await api.retrySession());
    } catch (error) {
      status.textContent = errorText(error);
      button.disabled = false;
    }
  };
  retry?.addEventListener("click", () => void onRetry(retry));
  show(
    h(
      "section",
      { class: "card center" },
      h("h1", {}, "Preparation failed"),
      h("p", {}, failure.message),
      retry,
      sessionActions("btn"),
      status,
    ),
  );
};

// ---------------------------------------------------------------------------
// Grammar journey: how much of each curriculum the learner understands.
// ---------------------------------------------------------------------------

const percent = (share: number): string =>
  `${(Math.max(0, Math.min(1, share)) * 100).toFixed(1)}%`;

/** Epoch milliseconds of the learner's last local midnight. */
const startOfToday = (): number => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
};

interface JourneyRow {
  readonly fill: HTMLElement;
  readonly bar: HTMLElement;
  readonly note: HTMLElement;
  readonly percent: HTMLElement;
  readonly root: HTMLElement;
  understood: number;
}

/**
 * One progress bar per curriculum, shown in Building blocks. Rows persist
 * between refreshes so the bar slides and the figure flashes as it ticks up.
 */
class Journey {
  public readonly element = h("section", {
    ariaLabel: "Grammar progress",
    class: "journey",
    hidden: true,
  });
  private readonly rows = new Map<string, JourneyRow>();
  private request = 0;
  private visible = false;

  public set shown(shown: boolean) {
    this.visible = shown;
    this.element.hidden = !shown || this.rows.size === 0;
    if (shown) {
      void this.refresh();
    }
  }

  /** Fetches the latest estimate; failures keep what is on screen. */
  public async refresh(): Promise<void> {
    if (!this.visible) {
      return;
    }
    this.request += 1;
    const request = this.request;
    let progress: ReadonlyArray<CurriculumProgress>;
    try {
      progress = await api.curriculumProgress(startOfToday());
    } catch {
      return;
    }
    if (request !== this.request) {
      return;
    }
    this.render(progress);
  }

  private render(progress: ReadonlyArray<CurriculumProgress>): void {
    const seen = new Set<string>();
    for (const curriculum of progress) {
      seen.add(curriculum.curriculumId);
      const row =
        this.rows.get(curriculum.curriculumId) ?? this.addRow(curriculum);
      const ticked = curriculum.understood > row.understood + 1e-9;
      row.understood = curriculum.understood;
      row.percent.textContent = percent(curriculum.understood);
      row.fill.style.width = percent(curriculum.understood);
      row.bar.setAttribute(
        "aria-valuenow",
        (curriculum.understood * 100).toFixed(1),
      );
      const today =
        curriculum.understoodBefore === null
          ? 0
          : (curriculum.understood - curriculum.understoodBefore) * 100;
      const change =
        Math.abs(today) >= 0.05
          ? ` · ${today > 0 ? "+" : "−"}${Math.abs(today).toFixed(1)}% today`
          : "";
      row.note.textContent = `${curriculum.established} of ${curriculum.targets} building blocks established${change}`;
      if (ticked) {
        row.percent.classList.remove("ticked");
        // Restart the animation.
        void row.percent.offsetWidth;
        row.percent.classList.add("ticked");
      }
    }
    for (const [id, row] of this.rows) {
      if (!seen.has(id)) {
        row.root.remove();
        this.rows.delete(id);
      }
    }
    this.element.hidden = !this.visible || this.rows.size === 0;
  }

  private addRow(curriculum: CurriculumProgress): JourneyRow {
    const fill = h("div", { class: "journey-fill" });
    const bar = h("div", { class: "journey-bar" }, fill);
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    bar.setAttribute("aria-label", `${curriculum.title} grammar understood`);
    const percentText = h("strong", { class: "journey-percent" });
    const note = h("p", { class: "journey-note" });
    const root = h(
      "div",
      { class: "journey-row" },
      h(
        "div",
        { class: "journey-head" },
        h("span", {}, `${curriculum.title} grammar`),
        percentText,
      ),
      bar,
      note,
    );
    this.element.append(root);
    const row: JourneyRow = {
      bar,
      fill,
      note,
      percent: percentText,
      root,
      understood: curriculum.understood,
    };
    this.rows.set(curriculum.curriculumId, row);
    return row;
  }
}

// ---------------------------------------------------------------------------
// Practice.
// ---------------------------------------------------------------------------

type ReadyView = Extract<SessionView, { readonly _tag: "Ready" }>;

/** A playback attempt, from request until it ends, fails or is cut short. */
interface Playback {
  readonly id: string;
  readonly presentation: Presentation;
}

class Practice {
  private readonly token: number;
  private readonly audio = new Audio();
  private queue: Array<PracticeItem> = [];
  /** The track future sentences come from, as last confirmed by the server. */
  private track: PracticeTrack;
  /** The mode of future crosstalk sentences, as last confirmed by the server. */
  private mode: PracticeMode;
  /** A track or mode change is being saved. */
  private saving = false;
  /**
   * Bumped when the stream changes, so `upcoming` responses requested
   * before the change are discarded rather than queued.
   */
  private queueGeneration = 0;
  /** Sentences answered locally, so a stale `upcoming` never shows them again. */
  private readonly answered = new Set<string>();
  /** Object URLs of prefetched audio, keyed by sentence id. */
  private readonly audioUrls = new Map<string, Promise<string>>();
  /** The current sentence's presentation, which every event is logged to. */
  private presentation: Presentation | undefined;
  private playback: Playback | undefined;
  private plays = 0;
  private revealed = false;
  private fetching = false;
  /** When the queue last ran dry, while it stays empty. */
  private drySince: number | undefined;
  private readonly saveTimer: ReturnType<typeof setInterval>;
  private answeredCount: number;
  private understoodCount: number;

  private readonly stats = h("p", { class: "stats" });
  private readonly playButton = h("button", { class: "play" });
  private readonly translation = h("p", { class: "translation", hidden: true });
  private readonly revealButton = h(
    "button",
    { class: "btn" },
    "Show translation",
  );
  private readonly understoodButton = h(
    "button",
    { class: "btn yes" },
    "Understood",
  );
  private readonly notUnderstoodButton = h(
    "button",
    { class: "btn no" },
    "Didn't understand",
  );
  private readonly hint = h("p", { class: "hint", role: "status" });
  private readonly stage = h("div", { class: "stage" });
  private readonly waitingText = h("p", {}, "Preparing more sentences…");
  private readonly waiting = h(
    "div",
    { class: "waiting", hidden: true },
    h("div", { ariaHidden: "true", class: "spinner" }),
    this.waitingText,
  );
  private readonly about = h("details", { class: "about" });
  private readonly journey = new Journey();
  private readonly trackStatus = h("p", {
    class: "mode-status",
    role: "status",
  });
  private readonly modeStatus = h("p", {
    class: "mode-status",
    role: "status",
  });
  /** Says when a curriculum answer is taking a while to be stored. */
  private readonly saveStatus = h("p", {
    class: "save-status",
    role: "status",
  });
  private readonly trackControl: Choice<PracticeTrack>;
  private readonly modeControl: Choice<PracticeMode>;

  public constructor(view: ReadyView) {
    this.answeredCount = view.stats.answered;
    this.understoodCount = view.stats.understood;
    this.track = view.track;
    this.mode = view.mode;
    this.trackControl = trackChoice(
      view.track,
      (track) => void this.changeTrack(track),
      this.trackStatus,
    );
    this.modeControl = modeChoice(
      view.mode,
      (mode) => void this.changeMode(mode),
      this.modeStatus,
    );
    this.modeControl.hidden = !modeApplies(view.track);
    this.audio.preload = "auto";

    this.playButton.addEventListener("click", () => void this.play());
    this.revealButton.addEventListener("click", () => {
      this.revealed = true;
      this.translation.hidden = false;
      this.revealButton.hidden = true;
      this.presentation?.record({ _tag: "TranslationRevealed" });
    });
    this.understoodButton.addEventListener("click", () => this.answer(true));
    this.notUnderstoodButton.addEventListener("click", () =>
      this.answer(false),
    );
    this.audio.addEventListener("playing", () =>
      this.playButton.classList.add("playing"),
    );
    for (const ev of ["pause", "ended", "error"]) {
      this.audio.addEventListener(ev, () =>
        this.playButton.classList.remove("playing"),
      );
    }
    this.audio.addEventListener("ended", () =>
      this.finishPlayback((playbackId) => ({
        _tag: "PlaybackEnded",
        playbackId,
        positionMs: this.positionMs(),
      })),
    );
    this.audio.addEventListener("pause", () => {
      // Reaching the end also pauses, and the app's own pauses are logged
      // where they happen (and may already have been followed by a new play).
      if (this.audio.ended || !this.audio.paused) {
        return;
      }
      this.finishPlayback((playbackId) => ({
        _tag: "PlaybackPaused",
        playbackId,
        positionMs: this.positionMs(),
      }));
    });
    this.audio.addEventListener("error", () =>
      this.finishPlayback((playbackId) => ({
        _tag: "PlaybackFailed",
        playbackId,
        reason: `media error ${this.audio.error?.code ?? "unknown"}`,
      })),
    );

    this.stage.append(
      this.playButton,
      this.hint,
      this.revealButton,
      this.translation,
      h(
        "div",
        { class: "answers" },
        this.notUnderstoodButton,
        this.understoodButton,
      ),
    );

    this.token = show(
      h("header", { class: "bar" }, this.stats, sessionActions("link")),
      this.journey.element,
      h("section", { class: "practice" }, this.stage, this.waiting),
      this.saveStatus,
      this.trackControl.element,
      this.modeControl.element,
      this.about,
    );
    this.saveTimer = setInterval(() => this.renderSaveStatus(), 1000);
    this.updateSession(view);
    this.renderStats();
    this.showCurrent(false);
    void this.fill();
  }

  public isMounted(): boolean {
    return this.token === screen;
  }

  public dispose(): void {
    clearInterval(this.saveTimer);
    this.stopPlayback("left");
    this.audio.pause();
    this.audio.removeAttribute("src");
    for (const url of this.audioUrls.values()) {
      void url.then(URL.revokeObjectURL, () => {});
    }
    this.audioUrls.clear();
  }

  public visibilityChanged(visible: boolean): void {
    if (this.isMounted()) {
      this.presentation?.record({ _tag: "VisibilityChanged", visible });
    }
  }

  public updateSession(view: ReadyView): void {
    if (!this.saving) {
      this.applyStream(view.track, view.mode);
    }
    // Also picks up progress made elsewhere when the page comes back.
    this.journey.shown = this.track === "curriculum";
    // Server stats may lag behind in-flight responses; never go backwards.
    this.answeredCount = Math.max(this.answeredCount, view.stats.answered);
    this.understoodCount = Math.max(
      this.understoodCount,
      view.stats.understood,
    );
    this.renderStats();
    const topics = view.topics.length > 0 ? view.topics.join(" · ") : "";
    this.about.replaceChildren(
      h(
        "summary",
        {},
        topics !== "" ? `Topics: ${topics}` : "About this session",
      ),
      h("p", {}, view.summary),
      h("p", { class: "muted" }, view.fileName),
    );
  }

  /** Picks up changes made elsewhere (another tab); errors are ignored. */
  public async sync(): Promise<void> {
    if (!this.isMounted()) {
      return;
    }
    try {
      const view = await api.currentSession();
      if (this.isMounted()) {
        render(view);
      }
    } catch {
      // Practice carries on; the next sync or fetch will try again.
    }
  }

  private get stream(): PracticeStream {
    return { mode: this.mode, track: this.track };
  }

  private async changeTrack(track: PracticeTrack): Promise<void> {
    if (track === this.track) {
      return;
    }
    await this.saveChange(
      async () => api.setTrack(track),
      this.trackStatus,
      "Couldn't change what you practice",
    );
  }

  private async changeMode(mode: PracticeMode): Promise<void> {
    if (mode === this.mode) {
      return;
    }
    await this.saveChange(
      async () => api.setMode(mode),
      this.modeStatus,
      "Couldn't change the level",
    );
  }

  /** Saves a track or mode change, then applies the server's view of it. */
  private async saveChange(
    request: () => Promise<SessionView>,
    status: HTMLElement,
    failure: string,
  ): Promise<void> {
    if (this.saving) {
      return;
    }
    this.saving = true;
    this.trackControl.disabled = true;
    this.modeControl.disabled = true;
    for (const element of [this.trackStatus, this.modeStatus]) {
      element.classList.remove("error");
      element.textContent = "";
    }
    status.textContent = "Saving…";
    try {
      const view = await request();
      if (!this.isMounted()) {
        return;
      }
      this.saving = false;
      status.textContent = "";
      render(view);
    } catch (error) {
      if (!this.isMounted()) {
        return;
      }
      this.trackControl.value = this.track;
      this.modeControl.value = this.mode;
      status.classList.add("error");
      status.textContent = `${failure}: ${errorText(error)}`;
    } finally {
      this.saving = false;
      this.trackControl.disabled = false;
      this.modeControl.disabled = false;
    }
  }

  /**
   * Switches future sentences to the given track and mode. The sentence on
   * screen stays, with its playback, translation and presentation;
   * prefetched ones are dropped if they belong to another stream.
   */
  private applyStream(track: PracticeTrack, mode: PracticeMode): void {
    const before = this.stream;
    this.track = track;
    this.mode = mode;
    this.trackControl.value = track;
    this.modeControl.value = mode;
    this.modeControl.hidden = !modeApplies(track);
    if (sameStream(before, this.stream)) {
      return;
    }
    this.queueGeneration += 1;
    const { kept, dropped } = keepCurrent(this.queue);
    this.queue = kept;
    for (const item of dropped) {
      const url = this.audioUrls.get(item.sentenceId);
      this.audioUrls.delete(item.sentenceId);
      void url?.then(URL.revokeObjectURL, () => {});
    }
    const status = before.track === track ? this.modeStatus : this.trackStatus;
    for (const element of [this.trackStatus, this.modeStatus]) {
      element.classList.remove("error");
      element.textContent = "";
    }
    status.textContent =
      this.current === undefined ? "" : "Applies after this sentence.";
    void this.fill();
  }

  private renderSaveStatus(): void {
    if (!this.isMounted()) {
      clearInterval(this.saveTimer);
      return;
    }
    const since = responses.oldestPendingAt();
    this.saveStatus.textContent =
      since !== undefined && Date.now() - since >= SAVE_HINT_DELAY_MS
        ? "Saving your last answer…"
        : "";
  }

  private renderStats(): void {
    this.stats.textContent = `${this.answeredCount} answered · ${this.understoodCount} understood`;
  }

  private get current(): PracticeItem | undefined {
    return this.queue[0];
  }

  /** Keeps the local queue topped up; polls while the server has nothing ready. */
  private async fill(): Promise<void> {
    if (this.fetching) {
      return;
    }
    this.fetching = true;
    let emptyPolls = 0;
    try {
      while (this.isMounted() && this.queue.length < QUEUE_CAPACITY) {
        const generation = this.queueGeneration;
        const stream = this.stream;
        let items: ReadonlyArray<PracticeItem>;
        try {
          items = await (stream.track === "curriculum"
            ? api.curriculumUpcoming()
            : api.upcoming());
        } catch {
          // Most likely the session went away (reset elsewhere); re-route.
          if (this.isMounted()) {
            void refresh();
          }
          return;
        }
        if (!this.isMounted()) {
          return;
        }
        if (generation !== this.queueGeneration) {
          // Asked before the stream changed; ask again.
          continue;
        }
        const { accepted, otherStream } = acceptUpcoming(this.queue, items, {
          answered: this.answered,
          capacity: Number.POSITIVE_INFINITY,
          stream,
        });
        if (otherStream && !this.saving) {
          // The server serves another stream, most likely changed elsewhere.
          void this.sync();
        }
        const wasEmpty = this.queue.length === 0;
        if (wasEmpty) {
          this.drySince ??= Date.now();
          if (
            stream.track === "curriculum" &&
            holdForReserve(accepted.length, Date.now() - this.drySince)
          ) {
            // Serving each sentence as it appears would mean waiting again
            // after every one; build a small reserve first.
            this.waitingText.textContent = `Preparing more sentences… ${accepted.length} of ${RESUME_RESERVE} ready`;
            await sleep(2000);
            continue;
          }
        }
        this.queue.push(
          ...accepted.slice(0, QUEUE_CAPACITY - this.queue.length),
        );
        this.preload();
        if (wasEmpty && this.queue.length > 0) {
          this.drySince = undefined;
          this.waitingText.textContent = "Preparing more sentences…";
          this.showCurrent(true);
        }
        if (this.queue.length === 0) {
          emptyPolls += 1;
          if (emptyPolls % 3 === 0 && !this.saving) {
            // Nothing arriving may mean the track changed in another tab.
            void this.sync();
          }
          await sleep(2000);
        } else {
          break;
        }
      }
    } finally {
      this.fetching = false;
    }
  }

  private preload(): void {
    for (const item of this.queue.slice(0, 2)) {
      if (this.audioUrls.has(item.sentenceId)) {
        continue;
      }
      const url = fetch(item.audioUrl)
        .then(async (res) => {
          if (!res.ok) {
            throw new Error(`audio HTTP ${res.status}`);
          }
          return res.blob();
        })
        .then((blob) => URL.createObjectURL(blob));
      url.catch(() => this.audioUrls.delete(item.sentenceId));
      this.audioUrls.set(item.sentenceId, url);
    }
  }

  private showCurrent(autoplay: boolean): void {
    const item = this.current;
    this.modeStatus.textContent = "";
    this.trackStatus.textContent = "";
    this.plays = 0;
    this.revealed = false;
    this.stopPlayback("answered");
    this.audio.pause();
    this.stage.hidden = item === undefined;
    this.waiting.hidden = item !== undefined;
    if (item === undefined) {
      this.presentation = undefined;
      return;
    }
    this.presentation = outbox.begin(item.sentenceId);
    this.presentation.record({
      _tag: "Presented",
      autoplay,
      visible: document.visibilityState === "visible",
    });
    this.playButton.textContent = "▶ Play";
    this.playButton.setAttribute("aria-label", "Play sentence");
    this.translation.textContent = item.english;
    this.translation.hidden = true;
    this.revealButton.hidden = false;
    this.hint.textContent = autoplay ? "" : "Tap to listen";
    if (autoplay) {
      void this.play(true);
    }
  }

  private async play(auto = false): Promise<void> {
    const item = this.current;
    const presentation = this.presentation;
    if (item === undefined || presentation === undefined) {
      return;
    }
    this.stopPlayback("replay", false);
    const playback: Playback = { id: randomUuid(), presentation };
    presentation.record({
      _tag: "PlayRequested",
      playbackId: playback.id,
      priorStarts: this.plays,
      trigger: auto ? "auto" : "tap",
    });
    this.playback = playback;
    let src = item.audioUrl;
    const cached = this.audioUrls.get(item.sentenceId);
    if (cached !== undefined) {
      try {
        src = await cached;
      } catch {
        // Fall back to streaming from the server.
      }
    }
    if (this.current !== item || !this.isMounted()) {
      return;
    }
    if (this.audio.src !== src) {
      this.audio.src = src;
    }
    this.audio.currentTime = 0;
    try {
      await this.audio.play();
    } catch (error) {
      if (this.playback === playback) {
        this.finishPlayback((playbackId) => ({
          _tag: "PlaybackFailed",
          playbackId,
          reason: error instanceof DOMException ? error.name : "unknown",
        }));
      }
      if (this.current !== item) {
        return;
      }
      this.hint.textContent =
        auto &&
        error instanceof DOMException &&
        error.name === "NotAllowedError"
          ? "Tap to listen"
          : "Couldn't play the audio. Tap to try again.";
      return;
    }
    if (this.current !== item) {
      return;
    }
    if (this.playback === playback) {
      const duration = this.audio.duration * 1000;
      presentation.record({
        _tag: "PlaybackStarted",
        audioDurationMs: Number.isFinite(duration) ? duration : null,
        playbackId: playback.id,
      });
    }
    this.plays += 1;
    this.hint.textContent = "";
    this.playButton.textContent = "↻ Replay";
    this.playButton.setAttribute("aria-label", "Replay sentence");
  }

  private positionMs(): number {
    const position = this.audio.currentTime * 1000;
    return Number.isFinite(position) && position > 0 ? position : 0;
  }

  /** Logs how the current playback ended and forgets it. */
  private finishPlayback(
    detail: (playbackId: string) => PresentationEventDetail,
  ): void {
    const playback = this.playback;
    if (playback === undefined) {
      return;
    }
    this.playback = undefined;
    playback.presentation.record(detail(playback.id));
  }

  /** Cuts the current playback short, if any; pauses the audio unless told not to. */
  private stopPlayback(
    reason: "replay" | "answered" | "left",
    pause = true,
  ): void {
    this.finishPlayback((playbackId) => ({
      _tag: "PlaybackInterrupted",
      playbackId,
      positionMs: this.positionMs(),
      reason,
    }));
    if (pause) {
      this.audio.pause();
    }
  }

  private answer(understood: boolean): void {
    const item = this.current;
    const presentation = this.presentation;
    if (item === undefined || presentation === undefined) {
      return;
    }
    presentation.record({ _tag: "Responded", understood });
    const payload = {
      presentationId: presentation.id,
      replayCount: Math.max(0, this.plays - 1),
      translationRevealed: this.revealed,
      understood,
    };
    this.answered.add(item.sentenceId);
    this.queue.shift();
    this.answeredCount += 1;
    if (understood) {
      this.understoodCount += 1;
    }
    this.renderStats();

    const url = this.audioUrls.get(item.sentenceId);
    this.audioUrls.delete(item.sentenceId);

    if (item.track === "curriculum") {
      // Curriculum answers are evidence of understanding: keep them until
      // the server has them, across reloads and lost connections.
      responses.enqueue(item.sentenceId, payload);
      // Progress counts the answer once it and its listening log are stored.
      void Promise.allSettled([responses.flush(), outbox.flush()]).then(
        async () => this.isMounted() && this.journey.refresh(),
      );
    }

    this.showCurrent(true);
    this.preload();
    void this.fill();
    void outbox.flush();

    if (item.track !== "curriculum") {
      void api.respond(item.sentenceId, payload).then(
        () => undefined,
        (error: unknown) => {
          // Answers are fire-and-forget; surface failures without blocking practice.
          console.error("Failed to record response", error);
          if (this.isMounted()) {
            this.hint.textContent = "Couldn't save the last answer.";
          }
        },
      );
    }
    // Revoke after the element has moved on to another source.
    void url?.then(
      (u) => setTimeout(() => URL.revokeObjectURL(u), 1000),
      () => {},
    );
  }
}

void refresh();
