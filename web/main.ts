/* eslint-disable effecttsgo/async-function, effecttsgo/global-console, effecttsgo/global-fetch, effecttsgo/global-timers, effecttsgo/new-promise -- The browser client is deliberately plain DOM and promise code; Effect is used only for the shared API schema and generated client. */
import { DEFAULT_PRACTICE_MODE } from "../src/domain/model.ts";
import type {
  PracticeItem,
  PracticeMode,
  PresentationEventDetail,
  SessionView,
} from "../src/domain/model.ts";
import * as api from "./api.ts";
import { acceptUpcoming, keepCurrent } from "./practiceQueue.ts";
import { PresentationOutbox, randomUuid } from "./presentationLog.ts";
import type { Presentation } from "./presentationLog.ts";

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
// Practice mode selector.
// ---------------------------------------------------------------------------

const modeOptions: ReadonlyArray<{
  readonly mode: PracticeMode;
  readonly label: string;
  readonly description: string;
}> = [
  {
    description: "Simple sentences with a single clause.",
    label: "Beginner",
    mode: "beginner",
  },
  {
    description: "Any sentence structure, including longer sentences.",
    label: "Intermediate",
    mode: "intermediate",
  },
];

let modeControls = 0;

/** A labelled radio group; native radios keep it keyboard accessible. */
class ModeControl {
  public readonly element: HTMLFieldSetElement;
  private readonly inputs = new Map<PracticeMode, HTMLInputElement>();

  public constructor(
    initial: PracticeMode,
    onChange: (mode: PracticeMode) => void,
    status?: HTMLElement,
  ) {
    modeControls += 1;
    const name = `practice-mode-${modeControls}`;
    this.element = h(
      "fieldset",
      { class: "mode" },
      h("legend", {}, "Sentence level"),
      ...modeOptions.map((option) => {
        const input = h("input", {
          checked: option.mode === initial,
          name,
          type: "radio",
          value: option.mode,
        });
        input.addEventListener("change", () => {
          if (input.checked) {
            onChange(option.mode);
          }
        });
        this.inputs.set(option.mode, input);
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

  public get value(): PracticeMode {
    for (const [mode, input] of this.inputs) {
      if (input.checked) {
        return mode;
      }
    }
    return DEFAULT_PRACTICE_MODE;
  }

  public set value(mode: PracticeMode) {
    const input = this.inputs.get(mode);
    if (input !== undefined) {
      input.checked = true;
    }
  }

  public set disabled(disabled: boolean) {
    this.element.disabled = disabled;
  }
}

// ---------------------------------------------------------------------------
// Presentation log: how each sentence was listened to, for later analysis.
// ---------------------------------------------------------------------------

const outbox = new PresentationOutbox({
  send: api.sendPresentationEvents,
  storage: (() => {
    try {
      return window.localStorage;
    } catch {
      return undefined;
    }
  })(),
});
// Deliver whatever an earlier visit could not.
void outbox.flush();

document.addEventListener("visibilitychange", () => {
  const visible = document.visibilityState === "visible";
  practice?.visibilityChanged(visible);
  if (!visible) {
    outbox.flushOnExit();
  } else {
    // The mode may have been changed in another tab meanwhile.
    void practice?.sync();
  }
});
window.addEventListener("pagehide", () => outbox.flushOnExit());

const knownErrors: Record<string, string> = {
  NoActiveSession: "There is no active session.",
  NotRetryable: "This step can't be retried. Start over with a new recording.",
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

const startOver = async (): Promise<void> => {
  if (
    !confirm(
      "Start over with a new recording? Your current session will be deleted.",
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
  const mode = new ModeControl(DEFAULT_PRACTICE_MODE, () => {});

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
    pick.classList.add("disabled");
    progress.hidden = false;
    progress.removeAttribute("value");
    status.classList.remove("error");
    status.textContent = "Uploading…";
    try {
      await api.uploadRecording(file, mode.value, (fraction) => {
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
        "Upload a recording of a crosstalk conversation. You'll get an endless stream of new Finnish sentences built from it to practice listening.",
      ),
      input,
      pick,
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
      h(
        "button",
        { class: "link", onclick: () => void startOver() },
        "Start over with a new recording",
      ),
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
      h(
        "button",
        { class: "btn", onclick: () => void startOver() },
        "Start over",
      ),
      status,
    ),
  );
};

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
  /** The mode future sentences come from, as last confirmed by the server. */
  private mode: PracticeMode;
  private savingMode = false;
  /**
   * Bumped when the mode changes, so `upcoming` responses requested before
   * the change are discarded rather than queued.
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
  private readonly waiting = h(
    "div",
    { class: "waiting", hidden: true },
    h("div", { ariaHidden: "true", class: "spinner" }),
    h("p", {}, "Preparing more sentences…"),
  );
  private readonly about = h("details", { class: "about" });
  private readonly modeStatus = h("p", {
    class: "mode-status",
    role: "status",
  });
  private readonly modeControl: ModeControl;

  public constructor(view: ReadyView) {
    this.answeredCount = view.stats.answered;
    this.understoodCount = view.stats.understood;
    this.mode = view.mode;
    this.modeControl = new ModeControl(
      view.mode,
      (mode) => void this.changeMode(mode),
      this.modeStatus,
    );
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
      h(
        "header",
        { class: "bar" },
        this.stats,
        h(
          "button",
          { class: "link", onclick: () => void startOver() },
          "Start over with a new recording",
        ),
      ),
      h("section", { class: "practice" }, this.stage, this.waiting),
      this.modeControl.element,
      this.about,
    );
    this.updateSession(view);
    this.renderStats();
    this.showCurrent(false);
    void this.fill();
  }

  public isMounted(): boolean {
    return this.token === screen;
  }

  public dispose(): void {
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
    if (!this.savingMode) {
      this.applyMode(view.mode);
    }
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

  private async changeMode(mode: PracticeMode): Promise<void> {
    if (this.savingMode || mode === this.mode) {
      return;
    }
    this.savingMode = true;
    this.modeControl.disabled = true;
    this.modeStatus.classList.remove("error");
    this.modeStatus.textContent = "Saving…";
    try {
      const view = await api.setMode(mode);
      if (!this.isMounted()) {
        return;
      }
      this.savingMode = false;
      this.modeStatus.textContent = "";
      render(view);
    } catch (error) {
      if (!this.isMounted()) {
        return;
      }
      this.modeControl.value = this.mode;
      this.modeStatus.classList.add("error");
      this.modeStatus.textContent = `Couldn't change the level: ${errorText(error)}`;
    } finally {
      this.savingMode = false;
      this.modeControl.disabled = false;
    }
  }

  /**
   * Switches future sentences to `mode`. The sentence on screen stays, with
   * its playback, translation and presentation; prefetched ones are dropped.
   */
  private applyMode(mode: PracticeMode): void {
    if (mode === this.mode) {
      return;
    }
    this.mode = mode;
    this.modeControl.value = mode;
    this.queueGeneration += 1;
    const { kept, dropped } = keepCurrent(this.queue);
    this.queue = kept;
    for (const item of dropped) {
      const url = this.audioUrls.get(item.sentenceId);
      this.audioUrls.delete(item.sentenceId);
      void url?.then(URL.revokeObjectURL, () => {});
    }
    this.modeStatus.classList.remove("error");
    this.modeStatus.textContent =
      this.current === undefined ? "" : "Applies after this sentence.";
    void this.fill();
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
    try {
      while (this.isMounted() && this.queue.length < 2) {
        const generation = this.queueGeneration;
        let items: ReadonlyArray<PracticeItem>;
        try {
          items = await api.upcoming();
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
          // Asked before the mode changed; ask again.
          continue;
        }
        const { accepted, otherMode } = acceptUpcoming(this.queue, items, {
          answered: this.answered,
          mode: this.mode,
        });
        if (otherMode && !this.savingMode) {
          // The server is in another mode, most likely changed elsewhere.
          void this.sync();
        }
        const wasEmpty = this.queue.length === 0;
        this.queue.push(...accepted);
        this.preload();
        if (wasEmpty && this.queue.length > 0) {
          this.showCurrent(true);
        }
        if (this.queue.length === 0) {
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

    this.showCurrent(true);
    this.preload();
    void this.fill();
    void outbox.flush();

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
    // Revoke after the element has moved on to another source.
    void url?.then(
      (u) => setTimeout(() => URL.revokeObjectURL(u), 1000),
      () => {},
    );
  }
}

void refresh();
