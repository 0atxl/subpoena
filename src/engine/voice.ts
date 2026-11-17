import { pickByHandle } from './hash.js';

export type StatuteId =
  | 'serial_laziness'
  | 'unlawful_hours'
  | 'friday_deployer'
  | 'direct_to_main'
  | 'graveyard'
  | 'licenseless_anarchy'
  | 'trigger_happy'
  | 'abandoned_forks';

export type VoiceCategory = StatuteId | 'acquitted' | 'insufficient_evidence';

export const STATUTE_LABELS: Record<StatuteId, string> = {
  serial_laziness: 'SERIAL LAZINESS',
  unlawful_hours: 'UNLAWFUL HOURS',
  friday_deployer: 'FRIDAY DEPLOYER',
  direct_to_main: 'DIRECT TO MAIN',
  graveyard: 'GRAVEYARD',
  licenseless_anarchy: 'LICENSELESS ANARCHY',
  trigger_happy: 'TRIGGER HAPPY',
  abandoned_forks: 'ABANDONED FORKS',
};

export const VOICE_BANKS: Record<VoiceCategory, readonly string[]> = {
  serial_laziness: [
    'Four letters, zero alibi.',
    'The log said "fix." Nothing else.',
    'Reads like a hasty ransom note.',
    "Three dots won't pass cross-exam.",
    'A vague message is a confession.',
    'Marked "wip" in fall; still on bail.',
    'No motive, just prints on the diff.',
    'Clerk asked why. Accused shrugged.',
    '"update" is what runners leave behind.',
    "Two words would've cleared your name.",
    '"stuff" stays on the docket forever.',
    'Even the diff forgets what "minor" meant.',
    'Brief to the point of perjury.',
    'Wiped every clue off the commit log.',
    'Another "changes," another cold case.',
    'Bailiff tossed weaker alibis at dawn.',
    'Suspect of few words, mostly "oops."',
  ],
  unlawful_hours: [
    'Citizens sleep; suspects rebase at 3 AM.',
    'Nothing honest ships by fridge light.',
    'Clock struck two; branch guards slept.',
    'Coffee went cold; judgment went colder.',
    'Midnight alibis end in dawn rollbacks.',
    'Streetlights out, witnesses zero.',
    'Night shift always catches the racers.',
    'Booked for loitering in main past two.',
    "Dawn broke; the stack trace didn't.",
    'Three AM is where bad bargains happen.',
    'Timestamps smell like burnt espresso.',
    'City slept while you fought a parser.',
    'No code review is awake at 4 AM.',
    'Only raccoons push after midnight.',
    "Clean minds don't patch before milkmen.",
    'Those hours belong in an affidavit.',
    "Fatigue isn't a defense in this court.",
  ],
  friday_deployer: [
    'Pulled the trigger at 4:45 and bolted.',
    'On-call took the hit while you logged off.',
    'Friday courage is Monday regret.',
    'Left the siren screaming and locked up.',
    'Pushed at dusk, vanished by happy hour.',
    'Any Friday push past four is planned.',
    'Pager rang all weekend; line went dead.',
    'Shut the laptop like a getaway door.',
    'Cold operator ships right at quitting.',
    "Saturday's outage already has your name.",
    'Called it a tweak; weekend called arson.',
    'Left a smoking build out on the curb.',
    'Tempted fate at five with no address.',
    "Five o'clock somewhere; prod paid up.",
    'Timing that makes SREs bolt the doors.',
    'Shipped on Friday, pled Fifth Monday.',
  ],
  direct_to_main: [
    'Skipped the jury, went straight to main.',
    'Branch rules were just polite advice.',
    'Who needs a PR when you hold the gavel?',
    'Blew past security with a raw push.',
    'No witnesses, just tire tracks on HEAD.',
    'Code review is only for strangers.',
    'Treated default branch like a notepad.',
    'Ran the red light without tapping brakes.',
    'Every push to main is an instant verdict.',
    'Left PR blank and kicked the door in.',
    'Asked who approved; the mirror blinked.',
    'Bold move—treating tests as optional.',
    'Raw commits on trunk, zero chaperones.',
    "If CI could talk, it'd press charges.",
    'Skipped the ticket, declared martial law.',
    'No second pair of eyes cleared the gate.',
  ],
  graveyard: [
    'Row of tombstones for weekend dreams.',
    'Not one star—just wind in empty READMEs.',
    'Started an empire, left a parking lot.',
    'Cold plots on the hill; nobody visits.',
    'Even bots walked past without a star.',
    'Grand openings, boarded up by March.',
    'More dead monuments than city hall.',
    'Silence in those repos echoes off stone.',
    'Built a ghost town in your own name.',
    'Unstarred, unforked, unbothered by all.',
    'Half-built scaffolds with the lights out.',
    'Zero applause, yet the curtain stays up.',
    'Quiet shelf of things nobody missed.',
    'Shipped tombstones, called it a resume.',
    "Even your alt wouldn't bookmark these.",
    'Others write diaries; you bury code.',
  ],
  licenseless_anarchy: [
    'No license, no rules, no legal mercy.',
    'Shipped with serial numbers filed off.',
    'Legal counsel took one look and drank.',
    'Proprietary by neglect, public by luck.',
    'All rights reserved by sheer oversight.',
    'Left code on the curb with no terms.',
    'Open invite shaped like a trap.',
    'Compliance wakes up sweating over this.',
    'Zero MIT, zero Apache, pure deniability.',
    'Built a rig, burned the title deed.',
    "Clean code won't excuse an untagged piece.",
    'Every lawyer in town just billed an hour.',
    'No COPYING file, just sovereign vibes.',
    'Fork at your peril; no lease was signed.',
    'Treated copyright like a soft warning.',
    'Publicly readable, legally radioactive.',
  ],
  trigger_happy: [
    'Burned the branches before ink dried.',
    'Nothing says innocent like shredded refs.',
    'Wiped the crime scene, swept the brass.',
    'Branches vanish faster than witnesses.',
    "Three refs yesterday; today it's ash.",
    'Quick on delete when spotlights hit.',
    'Tidy up or hide the tracks—pick one.',
    'Left dangling SHAs and faint gunsmoke.',
    'Refs disappear before every audit.',
    'Pulled half the tree, called it cleanup.',
    'Neat timelines mean somebody bought ash.',
    'Treats git branches like burner phones.',
    "History wasn't rewritten; it vanished.",
    'Too many deletions for a quiet Tuesday.',
    "Those branches didn't merge—they fled.",
    'Every question costs another missing ref.',
  ],
  abandoned_forks: [
    'Copied the plans, never flipped a switch.',
    'Forked with big hopes, parked on blocks.',
    'Took a souvenir, locked the garage.',
    'All the paperwork, zero commits inside.',
    'Untouched since day one—pure hoarding.',
    'Pristine clone gathering alley dust.',
    'Clicked Fork like ambition came free.',
    'Bought the suit, skipped the trial.',
    'Upstream moved on; your fork froze.',
    'Another trophy fork covered in cobwebs.',
    'Opened a branch office, hired nobody.',
    'Not theft if you never drive the car.',
    'Forked to win a debate, never returned.',
    'Zero follow-through, pure shelf weight.',
    'Took the keys, left the engine cold.',
    'A museum of dusty good intentions.',
  ],
  acquitted: [
    'Spotless record. Keep a tail on them.',
    'Walked out clean; desk still wonders.',
    'No priors—either saint or squash master.',
    'Alibi held up under harsh light.',
    'Clean enough to eat off. Too clean.',
    'Dismissed for lack of sloppy prints.',
    'Even night desk found no bad stamps.',
    "Acquitted—don't let it go to your head.",
    'Tidy logs look scrubbed before a raid.',
    'Tore the index apart; found only manners.',
    'Released on recognizance; clerk sighed.',
    'No dirt on file—nobody stays clean long.',
    'Walked on a technicality: competence.',
    'Prosecutor muttered about lint rules.',
    'Zero counts. Somebody reads their diffs.',
    'Cleared for now. Keep branches small.',
  ],
  insufficient_evidence: [
    'Half the file is missing from the clerk.',
    'Pages torn from the ledger before dawn.',
    'Dossier came in light; hold the seal.',
    'Key exhibits vanished in transit.',
    'Cannot clear a suspect on half a file.',
    'Records clerk found an empty folder.',
    'Evidence locker came up short today.',
    'Index went dark before we pulled prints.',
    'Filing cabinet was jimmied; logs missing.',
    'No acquittal without a full paper trail.',
    'Precinct wire dropped half the exhibits.',
    'Docket stayed open pending missing pages.',
    'Witnesses no-showed; file stays unsealed.',
    'Red ink waits for the rest of the tape.',
    'Too many gaps in the precinct archive.',
    'Unsealed dossier—exhibits still at large.',
  ],
};

export const OFFICERS: readonly string[] = [
  'Det. R. Halloran',
  'Det. M. Okafor',
  'Sgt. L. Brandt',
  'Det. J. Quill',
  'Insp. C. Vance',
  'Lt. E. Morales',
  'Det. S. Kowalski',
  'Sgt. D. Calloway',
  'Capt. H. Sterling',
  'Det. V. Marlowe',
  'Insp. K. Sato',
  'Lt. N. Gallagher',
  'Det. B. Navarro',
  'Sgt. P. Malone',
  'Det. T. Mercer',
  'Insp. A. Lindqvist',
];

export const RECEIVING_DESKS: readonly string[] = [
  'Desk 4, night shift',
  'Intake Window 2',
  'Precinct 9, Central',
  'Night Clerk, Annex B',
];

export const SENTENCING_LINES: readonly string[] = [
  '90 days of mandatory code review',
  '200 hours of writing unit tests without mocks',
  '6 months supervised pull requests on weekdays only',
  'Suspended license pending README restitution',
  'Community service: triaging stale issues',
  'Probation with mandatory pre-commit hooks',
];

export const BOT_DIRECTIVE_LINES: readonly string[] = [
  'Automated agent operating on scheduled hooks; personal-habit statutes waived by the court.',
  'Non-human actor executing unattended workflows; sleep and weekend statutes do not apply.',
  'Daemon process bound to repository webhooks; personal-conduct counts omitted from docket.',
  'Scripted service account with no pulse on file; human-habit charges waived.',
];

export const BOT_STING_LINES: readonly string[] = [
  'You cannot cross-examine a cron job.',
  'No conscience, just a webhook token.',
  'Cold silicon never pleads the Fifth.',
  'Clockwork alibi; zero human prints.',
];

export function getStingLine(handle: string, category: VoiceCategory): string {
  return pickByHandle(VOICE_BANKS[category], handle, `sting:${category}`);
}

export function getOfficer(handle: string): string {
  return pickByHandle(OFFICERS, handle, 'officer');
}

export function getReceivingDesk(handle: string): string {
  return pickByHandle(RECEIVING_DESKS, handle, 'desk');
}

export function getSentence(handle: string): string {
  return pickByHandle(SENTENCING_LINES, handle, 'sentence');
}

export function getBotAddendum(handle: string): {
  header: string;
  receipt: string;
  sting: string;
} {
  return {
    header: 'AUTOMATON DIRECTIVE: HABIT STATUTES WAIVED',
    receipt: pickByHandle(BOT_DIRECTIVE_LINES, handle, 'bot:directive'),
    sting: pickByHandle(BOT_STING_LINES, handle, 'bot:sting'),
  };
}
