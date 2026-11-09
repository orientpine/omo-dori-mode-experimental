// "words" marks status as [working] / [waiting] / [done] / [standing]; "emoji" uses 🔄 / 🔔 / ✅ / 📌 (and ⏳ / ✅ in progress text).
export type StatusStyle = "words" | "emoji";

// The speech this Dori uses with its owner in his channel and threads, which a lane's summary for him has to match (the
// lanes write to the lead politely; 2026-10-20 a lane's ~요 summary went out under ZzangDori's name, owner "가끔 이렇게 너
// 말투 달라지는 거니? 왜 달라지는 거야?"). "" follows discord.locale: Korean is casual (반말), any other locale is not checked.
export type OwnerSpeech = "" | "casual" | "polite";
export const OWNER_SPEECHES: readonly OwnerSpeech[] = ["", "casual", "polite"];
export const ownerSpeechOf = (locale: string, speech: OwnerSpeech = ""): OwnerSpeech => speech || (locale.toLowerCase().startsWith("ko") ? "casual" : "");

// Words the Discord helpers write: thread status words, question-card labels, and how answer times are shown.
// autoUnEye: the listener takes its eyes reaction off the owner's earlier messages once its bot writes in that channel.
// freshness posts nothing in the owner's thread on its own; a silent lane is the lead's to retell. A close posts the
// lane's summary for the owner (close-summary.ts), not fixed words. laneStartText is the first message
// dori launch posts in a discord:<id> work thread that has none ({title}, {goal}, {brief}, {done}, {key}, {pane}; a line
// whose placeholder is empty is left out). waiveText is the line the owner gets when dori launch --waive leaves one of his
// directives out of a brief ({key}, {id}, {name}, {reason}): in the lane's discord:<id> thread, else DORI_DISCORD_CHANNEL.
// leadRunawayText / leadPausedText follow the LEAD_RUNAWAY / LEAD_AUTOTURN_PAUSED head dori watch posts to the pair channel
// and DORI_DISCORD_CHANNEL when the lead itself ran autoturnLongTurns turns on its own or omo paused it ({pane}, {turns},
// {since}, {reason}). leadRepeatText follows "<head> repeat:" when the last alert that asked for a check is under 30 min
// old ({pane}, {turns}, {since}, {reason}, {min} = minutes since that alert, {at} = its time): it asks for nothing.
// leadCompactionStuckText follows the LEAD_COMPACTION_STUCK head dori freshness posts the same way, once per lead pane, when
// the lead answers every message with the engine's "compaction did not complete" error and nothing moves it: the auto key
// is off or the automatic handover was refused or failed ({pane}, {turns} = the error's count on its screen, {since} = when
// freshness first saw it due, {reason} = why it did not move).
export type DiscordWords = {
  readonly statusStyle: StatusStyle;
  readonly autoUnEye: boolean;
  readonly laneStartText: string;
  readonly waiveText: string;
  readonly leadRunawayText: string;
  readonly leadPausedText: string;
  readonly leadRepeatText: string;
  readonly leadCompactionStuckText: string;
  // the owner's line from dori watch when the lead's model calls fail while his message waits (lead-limit.ts):
  // leadLimitText names the retry time the error gives ({until}, discord.timeZone), leadLimitNoTimeText the error
  // ({reason}) when it gives none; leadBackText goes to the same place once a reply works again
  readonly leadLimitText: string;
  readonly leadLimitNoTimeText: string;
  readonly leadBackText: string;
  // the owner's line when dori watch starts a lead that was down (lead-down.ts; {since}: when it went down, discord.timeZone)
  readonly leadDownText: string;
  // the owner's line when dori watch brought a stopped lead back, or could not ({reason}) (lead-resume.ts)
  readonly leadResumedText: string;
  readonly leadResumeFailText: string;
  // minutes a done (✅) thread in DORI_DISCORD_CHANNEL stays quiet before freshness archives it (0: never; a thread an open
  // lane, an open card or a pending rename holds is left open)
  readonly autoArchiveMin: number;
  readonly working: string;
  readonly waiting: string;
  readonly standing: string;
  readonly done: string;
  readonly other: string;
  readonly pick: string;
  readonly recommended: string;
  readonly answered: string;
  readonly ownerOnly: string;
  // a tap on a card whose post Discord has not answered yet, past the wait a tap can afford
  readonly cardPosting: string;
  readonly byButton: string;
  readonly byText: string;
  // a card folded by dori resolve: the owner answered in a message; repliedInText is the answer shown without --answer
  readonly byReply: string;
  readonly repliedInText: string;
  readonly locale: string;
  readonly timeZone: string;
  readonly ownerSpeech: OwnerSpeech;
  // the user id of this Dori's own bot; Discord writes refuse a DORI_DISCORD_TOKEN of another bot (empty: no check)
  readonly botId: string;
  // role ids that call this Dori besides the roles its bot member has (read at listener start): an owner message anywhere
  // in the guild that mentions its bot or one of these roles reaches the inbox (scope "mention")
  readonly mentionRoleIds: readonly string[];
  // names the owner calls this Dori by ("짱돌", "짱도리", "ZzangDori"): an owner message in the pair channel that names none
  // of them, mentions neither its bot nor its roles and replies to none of its posts did not call it, so its eyes come off
  // when another Dori answers that message (empty: they stay until this Dori writes there)
  readonly callNames: readonly string[];
};

export const defaultDiscordWords: DiscordWords = {
  statusStyle: "words",
  autoUnEye: true,
  laneStartText: "{title}\nGoal, in your words: {goal}\n{brief}\nDone when: {done}\nLane {key}, pane {pane}",
  waiveText: "Lane {key} was launched without your directive {id} ({name}). The lead's reason: {reason}",
  leadRunawayText: "The lead {pane} has started {turns} turns on its own since its last user message ({since}). Other Dori: type one short check message into {pane}; do not stop it.",
  leadPausedText: "omo paused the lead {pane} after {turns} turns on its own ({reason}, since {since}). Other Dori: type one short check message into {pane}; do not stop it.",
  leadRepeatText: "The lead {pane} is still on its own ({turns} turns). A check was already asked for {min} min ago ({at}): send no new message.",
  leadCompactionStuckText: "The lead {pane} answers every message with \"compaction did not complete\" ({turns} times on its screen, due since {since}) and was not moved to a new session: {reason}. Other Dori: tell your lead; this lead needs dori handover to a new session on its host.",
  leadLimitText: "I can't answer right now: my model is at its usage limit until about {until}. I'll read your messages then.",
  leadLimitNoTimeText: "I can't answer right now: my model calls fail ({reason}). I'll read your messages once they work again.",
  leadBackText: "My model works again; reading your messages now.",
  leadDownText: "My session went down at {since}; I'm starting it again in the same conversation and will answer in a few minutes.",
  leadResumedText: "My session had stopped; it runs again and I'm reading your messages now.",
  leadResumeFailText: "My session has stopped and I could not start it again ({reason}). Your messages wait until it runs.",
  autoArchiveMin: 30,
  working: "working",
  waiting: "waiting",
  standing: "standing",
  done: "done",
  other: "Write my own",
  pick: "Pick {n}",
  recommended: "recommended",
  answered: "answered",
  ownerOnly: "Only the owner can answer this.",
  cardPosting: "This card is still being posted; tap again.",
  byButton: "button",
  byText: "typed",
  byReply: "reply",
  repliedInText: "answered in text",
  locale: "en-US",
  timeZone: "UTC",
  ownerSpeech: "",
  botId: "",
  mentionRoleIds: [],
  callNames: [],
};
