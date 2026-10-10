import type {
  BackgroundGrammar,
  Catalog,
  Example,
  LearningTarget,
  Realisation,
  TargetId,
} from "../Catalog.ts";

/**
 * A1 listening targets in a conventional beginner teaching order. Targets
 * are not grouped into chapters.
 * Form rules that cannot be judged from a comprehension response (vowel
 * harmony, consonant gradation, word and verb types) are background grammar,
 * never targets. Drafted by an agent and not yet checked by a Finnish reviewer.
 */

const example = (finnish: string, english: string): Example => ({
  english,
  finnish,
});

const spoken = (
  form: string,
  ...examples: ReadonlyArray<Example>
): Realisation => ({ examples, form, register: "spoken" });

const standard = (
  form: string,
  ...examples: ReadonlyArray<Example>
): Realisation => ({ examples, form, register: "standard" });

const target = (
  definition: Omit<LearningTarget, "review" | "revision">,
): LearningTarget => ({ ...definition, review: "unreviewed", revision: 1 });

const background = (
  id: string,
  description: string,
  requires: ReadonlyArray<TargetId>,
  ...examples: ReadonlyArray<Example>
): BackgroundGrammar => ({ description, examples, id, requires });

export const pilotCatalog: Catalog = {
  background: [
    background(
      "background-copula-statements",
      "Affirmative present statements with a noun or name subject and olla; nominative noun, adjective, nationality or profession complements; names and simple numbers",
      [],
      example("Juho on opettaja.", "Juho is a teacher."),
      example("Talo on iso.", "The house is big."),
    ),
    background(
      "background-present-verbs-type-1",
      "Present-tense verbs of type 1 in every person, and puhua with a language in the partitive",
      ["participants-i-you"],
      example("Anna puhuu hitaasti.", "Anna speaks slowly."),
      example("Anna puhuu suomea.", "Anna speaks Finnish."),
    ),
    background(
      "background-partitive-counting-and-verbs",
      "The partitive after numbers and after common verbs that take it (rakastaa, auttaa, etsiä, katsoa, ymmärtää, soittaa an instrument)",
      ["possession-have"],
      example("Juholla on kaksi koiraa.", "Juho has two dogs."),
      example("Anna rakastaa Juhoa.", "Anna loves Juho."),
    ),
    background(
      "background-present-verbs-all-types",
      "Present-tense verbs of types 1–5 and more verbs taking the partitive, such as pelata, opiskella, juhlia and häiritä",
      ["possession-have", "object-person"],
      example("Kalle pelaa jalkapalloa.", "Kalle plays football."),
      example("Anna opiskelee historiaa.", "Anna studies history."),
    ),
    background(
      "background-mass-partitive",
      "The partitive of mass nouns, such as food and drink, as the object or as an amount that exists",
      ["existential-there-is", "number-plural"],
      example("Juho juo kahvia.", "Juho drinks coffee."),
      example("Kaupassa on maitoa.", "There is milk in the shop."),
    ),
  ],
  targets: [
    target({
      contrast: "The speaker versus the listener in the same statement",
      exclusions: ["plural persons"],
      id: "participants-i-you",
      meaning: "Who it is about: I or you",
      prerequisites: [],
      realisations: [
        spoken(
          "mä / sä with first- and second-person verb forms",
          example("Mä oon opettaja.", "I am a teacher."),
          example("Sä oot opettaja.", "You are a teacher."),
        ),
        standard(
          "minä / sinä with first- and second-person verb forms",
          example("Minä olen opettaja.", "I am a teacher."),
          example("Sinä olet opettaja.", "You are a teacher."),
        ),
      ],
      variationDimensions: ["person", "complement", "verb"],
    }),
    target({
      contrast: "The same statement with and without negation",
      exclusions: [],
      id: "negation-present",
      meaning: "Whether it is so: is or isn't, does or doesn't",
      prerequisites: [],
      realisations: [
        spoken(
          "ei / en / et + verb stem",
          example("Talo ei oo iso.", "The house isn't big."),
          example("Talo on iso.", "The house is big."),
        ),
        standard(
          "ei / en / et + verb stem",
          example("Talo ei ole iso.", "The house isn't big."),
          example("Talo on iso.", "The house is big."),
        ),
      ],
      variationDimensions: ["subject", "verb", "affirmative or negative"],
    }),
    target({
      contrast: "A statement versus the yes-no question asking it",
      exclusions: ["question words"],
      id: "question-yes-no",
      meaning: "Whether it is stated or asked",
      prerequisites: [],
      realisations: [
        spoken(
          "fronted verb + -ks / -kö, or fused pronoun forms such as -tsä",
          example("Onks talo iso?", "Is the house big?"),
          example("Talo on iso.", "The house is big."),
        ),
        standard(
          "-ko / -kö on the fronted verb",
          example("Onko talo iso?", "Is the house big?"),
          example("Talo on iso.", "The house is big."),
        ),
      ],
      variationDimensions: ["subject", "verb", "statement or question"],
    }),
    target({
      contrast: "Which information is asked for: who, what, where or when",
      exclusions: ["yes-no questions"],
      id: "question-words",
      meaning: "What is being asked",
      prerequisites: [],
      realisations: [
        standard(
          "kuka / mikä / mitä / missä / milloin at the front",
          example("Kuka Juho on?", "Who is Juho?"),
          example("Mikä talo on iso?", "Which house is big?"),
        ),
      ],
      variationDimensions: ["question word", "subject"],
    }),
    target({
      contrast:
        "The place someone comes from versus other information about them",
      exclusions: ["movement out of a place"],
      id: "origin-from",
      meaning: "Where someone is from",
      prerequisites: [],
      realisations: [
        standard(
          "olla kotoisin + -sta / -stä",
          example("Juho on kotoisin Oulusta.", "Juho is from Oulu."),
          example("Anna on kotoisin Suomesta.", "Anna is from Finland."),
        ),
      ],
      variationDimensions: ["person", "country or town"],
    }),
    target({
      contrast: "The listener or someone else versus the speaker",
      exclusions: ["plural persons"],
      id: "participants-third-person",
      meaning: "Who it is about: someone else (he or she)",
      prerequisites: ["participants-i-you"],
      realisations: [
        spoken(
          "se (for a person) with the third-person verb",
          example("Se on opettaja.", "He is a teacher."),
          example("Mä oon opettaja.", "I am a teacher."),
        ),
        standard(
          "hän with the third-person verb",
          example("Hän on opettaja.", "She is a teacher."),
          example("Minä olen opettaja.", "I am a teacher."),
        ),
      ],
      variationDimensions: ["person", "complement", "verb"],
    }),
    target({
      contrast: "One person versus a group: we, you (plural) or they",
      exclusions: [],
      id: "participants-plural",
      meaning: "Who it is about: we, you all or they",
      prerequisites: ["participants-i-you", "participants-third-person"],
      realisations: [
        spoken(
          "me / te / ne with spoken plural verb forms",
          example("Me puhutaan suomea.", "We speak Finnish."),
          example("Ne puhuu englantia.", "They speak English."),
        ),
        standard(
          "me / te / he with plural verb endings",
          example("Me puhumme suomea.", "We speak Finnish."),
          example("He puhuvat englantia.", "They speak English."),
        ),
      ],
      variationDimensions: ["person", "verb"],
    }),
    target({
      contrast: "Whose thing it is",
      exclusions: ["possessive suffixes"],
      id: "genitive-possessor",
      meaning: "Whose it is",
      prerequisites: [],
      realisations: [
        spoken(
          "mun / sun / name or noun + -n before the thing",
          example("Juhon auto on iso.", "Juho's car is big."),
          example("Mun auto on pieni.", "My car is small."),
        ),
        standard(
          "minun / sinun / name or noun + -n before the thing",
          example("Juhon auto on iso.", "Juho's car is big."),
          example("Minun auto on pieni.", "My car is small."),
        ),
      ],
      variationDimensions: ["possessor", "possessed thing"],
    }),
    target({
      contrast: "Who has the thing",
      exclusions: ["negated possession"],
      id: "possession-have",
      meaning: "Who has it",
      prerequisites: [],
      realisations: [
        spoken(
          "mulla / sulla / name + -lla on + nominative",
          example("Mulla on auto.", "I have a car."),
          example("Juholla on koira.", "Juho has a dog."),
        ),
        standard(
          "minulla / sinulla / name + -lla on + nominative",
          example("Minulla on auto.", "I have a car."),
          example("Juholla on koira.", "Juho has a dog."),
        ),
      ],
      variationDimensions: ["possessor", "possessed noun"],
    }),
    target({
      contrast: "Someone having something versus not having it",
      exclusions: [],
      id: "possession-negated",
      meaning: "Whether someone has it",
      prerequisites: ["possession-have", "negation-present"],
      realisations: [
        spoken(
          "possessor + ei oo + partitive",
          example("Mulla ei oo autoa.", "I don't have a car."),
          example("Mulla on auto.", "I have a car."),
        ),
        standard(
          "possessor + ei ole + partitive",
          example("Minulla ei ole autoa.", "I don't have a car."),
          example("Minulla on auto.", "I have a car."),
        ),
      ],
      variationDimensions: ["possessor", "possessed noun", "has or doesn't"],
    }),
    target({
      contrast: "Which person receives the action",
      exclusions: [],
      id: "object-person",
      meaning: "Who it is done to: me, you, him or her",
      prerequisites: ["participants-i-you", "participants-third-person"],
      realisations: [
        spoken(
          "mua / sua / häntä / sitä after partitive verbs",
          example("Juho auttaa mua.", "Juho helps me."),
          example("Mä autan sua.", "I help you."),
        ),
        standard(
          "minua / sinua / häntä after partitive verbs",
          example("Juho auttaa minua.", "Juho helps me."),
          example("Minä autan sinua.", "I help you."),
        ),
      ],
      variationDimensions: ["actor", "person receiving", "verb"],
    }),
    target({
      contrast: "Doing something alone versus with someone",
      exclusions: [],
      id: "with-someone",
      meaning: "Who someone is with",
      prerequisites: ["genitive-possessor"],
      realisations: [
        spoken(
          "genitive + kanssa",
          example("Mä asun Juhon kanssa.", "I live with Juho."),
          example(
            "Anna puhuu opettajan kanssa.",
            "Anna talks with the teacher.",
          ),
        ),
        standard(
          "genitive + kanssa",
          example("Minä asun Juhon kanssa.", "I live with Juho."),
          example(
            "Anna puhuu opettajan kanssa.",
            "Anna talks with the teacher.",
          ),
        ),
      ],
      variationDimensions: ["companion", "activity"],
    }),
    target({
      contrast: "Inside one place versus another",
      exclusions: ["movement"],
      id: "location-inside",
      meaning: "Where it is: inside a place",
      prerequisites: [],
      realisations: [
        standard(
          "-ssa / -ssä (inessive)",
          example("Kissa on talossa.", "The cat is in the house."),
          example("Koira on autossa.", "The dog is in the car."),
        ),
      ],
      variationDimensions: ["place", "subject"],
    }),
    target({
      contrast: "Being on or at a place versus inside it",
      exclusions: ["movement"],
      id: "location-on-at",
      meaning: "Where it is: on or at a place",
      prerequisites: ["location-inside"],
      realisations: [
        standard(
          "-lla / -llä (adessive) for places",
          example("Kirja on pöydällä.", "The book is on the table."),
          example("Kirja on laukussa.", "The book is in the bag."),
        ),
      ],
      variationDimensions: ["place", "subject", "inside or on"],
    }),
    target({
      contrast: "Moving into a place versus being in it",
      exclusions: ["movement out of a place"],
      id: "direction-into",
      meaning: "Where it goes: into a place",
      prerequisites: ["location-inside"],
      realisations: [
        spoken(
          "illative after mennä and similar movement verbs",
          example("Mä meen kauppaan.", "I go into the shop."),
          example("Mä oon kaupassa.", "I am in the shop."),
        ),
        standard(
          "illative (vowel + -n, -hVn, -seen)",
          example("Minä menen kauppaan.", "I go into the shop."),
          example("Minä olen kaupassa.", "I am in the shop."),
        ),
      ],
      variationDimensions: ["place", "subject", "movement verb"],
    }),
    target({
      contrast: "Moving onto or to a place versus being on or at it",
      exclusions: ["movement off a place"],
      id: "direction-onto",
      meaning: "Where it goes: onto or to a place",
      prerequisites: ["location-on-at"],
      realisations: [
        spoken(
          "-lle (allative) after mennä and similar movement verbs",
          example("Mä meen torille.", "I go to the market square."),
          example("Mä oon torilla.", "I am at the market square."),
        ),
        standard(
          "-lle (allative) for places",
          example("Minä menen torille.", "I go to the market square."),
          example("Kissa menee pöydälle.", "The cat goes onto the table."),
        ),
      ],
      variationDimensions: ["place", "subject", "movement verb"],
    }),
    target({
      contrast: "Coming out of a place versus going into it",
      exclusions: ["origin with kotoisin"],
      id: "direction-out-of",
      meaning: "Where it comes from: out of a place",
      prerequisites: ["direction-into"],
      realisations: [
        spoken(
          "-sta / -stä (elative) after tulla and similar movement verbs",
          example("Mä tuun kaupasta.", "I come out of the shop."),
          example("Mä meen kauppaan.", "I go into the shop."),
        ),
        standard(
          "-sta / -stä (elative)",
          example("Minä tulen kaupasta.", "I come out of the shop."),
          example("Minä menen kauppaan.", "I go into the shop."),
        ),
      ],
      variationDimensions: ["place", "subject", "movement verb"],
    }),
    target({
      contrast: "Coming off or from a place versus going onto or to it",
      exclusions: [],
      id: "direction-off-from",
      meaning: "Where it comes from: off or from a place",
      prerequisites: ["direction-onto"],
      realisations: [
        spoken(
          "-lta / -ltä (ablative) after tulla and similar movement verbs",
          example("Mä tuun torilta.", "I come from the market square."),
          example("Mä meen torille.", "I go to the market square."),
        ),
        standard(
          "-lta / -ltä (ablative) for places",
          example("Minä tulen torilta.", "I come from the market square."),
          example("Kissa tulee pöydältä.", "The cat comes off the table."),
        ),
      ],
      variationDimensions: ["place", "subject", "movement verb"],
    }),
    target({
      contrast:
        "Saying that something exists in a place versus where a known thing is",
      exclusions: [],
      id: "existential-there-is",
      meaning: "Whether something is there, or where it is",
      prerequisites: ["location-inside"],
      realisations: [
        standard(
          "place + on + thing",
          example("Huoneessa on sohva.", "There is a sofa in the room."),
          example("Sohva on huoneessa.", "The sofa is in the room."),
        ),
      ],
      variationDimensions: ["place", "thing", "existence or location"],
    }),
    target({
      contrast: "One thing versus several",
      exclusions: ["plural partitive"],
      id: "number-plural",
      meaning: "How many: one or several",
      prerequisites: [],
      realisations: [
        spoken(
          "nominative plural -t with a spoken singular verb",
          example("Kissat on talossa.", "The cats are in the house."),
          example("Kissa on talossa.", "The cat is in the house."),
        ),
        standard(
          "nominative plural -t with a plural verb",
          example("Kissat ovat talossa.", "The cats are in the house."),
          example("Kissa on talossa.", "The cat is in the house."),
        ),
      ],
      variationDimensions: ["noun", "one or several"],
    }),
    target({
      contrast: "Telling the listener to do something versus saying they do it",
      exclusions: ["plural or polite commands"],
      id: "imperative-you",
      meaning: "Whether it is a command",
      prerequisites: ["participants-i-you"],
      realisations: [
        spoken(
          "the verb stem as a command to one listener",
          example("Puhu suomea!", "Speak Finnish!"),
          example("Sä puhut suomea.", "You speak Finnish."),
        ),
        standard(
          "the verb stem as a command to one listener",
          example("Puhu suomea!", "Speak Finnish!"),
          example("Sinä puhut suomea.", "You speak Finnish."),
        ),
      ],
      variationDimensions: ["verb", "command or statement"],
    }),
    target({
      contrast: "Something near the speaker versus something further away",
      exclusions: ["inflected demonstratives", "plural demonstratives"],
      id: "reference-this-that",
      meaning: "Which thing: this one or that one",
      prerequisites: [],
      realisations: [
        spoken(
          "tää / toi as copula subjects",
          example("Tää on koira.", "This is a dog."),
          example("Toi on kissa.", "That is a cat."),
        ),
        standard(
          "tämä / tuo as copula subjects",
          example("Tämä on koira.", "This is a dog."),
          example("Tuo on kissa.", "That is a cat."),
        ),
      ],
      variationDimensions: ["noun", "adjective", "near or far"],
    }),
    target({
      contrast: "Here versus over there or in the place mentioned",
      exclusions: ["movement to or from here or there"],
      id: "location-here-there",
      meaning: "Where it is: here or there",
      prerequisites: ["reference-this-that", "location-inside"],
      realisations: [
        spoken(
          "tääl / tuol / siel",
          example("Kissa on tääl.", "The cat is here."),
          example("Koira on tuol.", "The dog is over there."),
        ),
        standard(
          "täällä / tuolla / siellä",
          example("Kissa on täällä.", "The cat is here."),
          example("Koira on tuolla.", "The dog is over there."),
        ),
      ],
      variationDimensions: ["subject", "here or there"],
    }),
    target({
      contrast: "Where something is relative to another thing",
      exclusions: ["movement with postpositions"],
      id: "location-postpositions",
      meaning: "Where it is: in front of, behind, next to, under or on",
      prerequisites: ["genitive-possessor", "location-inside"],
      realisations: [
        standard(
          "genitive + edessä / takana / vieressä / alla / päällä",
          example("Kissa on pöydän alla.", "The cat is under the table."),
          example("Auto on talon edessä.", "The car is in front of the house."),
        ),
      ],
      variationDimensions: ["reference thing", "position", "subject"],
    }),
    target({
      contrast: "The person something is directed to",
      exclusions: [],
      id: "recipient-to-whom",
      meaning: "Who it is for or to",
      prerequisites: ["direction-onto"],
      realisations: [
        spoken(
          "mulle / sulle / person + -lle",
          example("Mä soitan Juholle.", "I call Juho."),
          example("Anna puhuu sulle.", "Anna is talking to you."),
        ),
        standard(
          "minulle / sinulle / person + -lle",
          example("Minä soitan Juholle.", "I call Juho."),
          example("Anna puhuu sinulle.", "Anna is talking to you."),
        ),
      ],
      variationDimensions: ["recipient", "verb"],
    }),
    target({
      contrast: "The person something comes from or is asked from",
      exclusions: [],
      id: "source-from-whom",
      meaning: "Who it comes from",
      prerequisites: ["direction-off-from"],
      realisations: [
        spoken(
          "multa / sulta / person + -lta",
          example("Mä kysyn Juholta.", "I ask Juho."),
          example("Anna kysyy sulta.", "Anna asks you."),
        ),
        standard(
          "minulta / sinulta / person + -lta",
          example("Minä kysyn Juholta.", "I ask Juho."),
          example("Anna kysyy sinulta.", "Anna asks you."),
        ),
      ],
      variationDimensions: ["source person", "verb"],
    }),
    target({
      contrast: "A reason connected to a statement",
      exclusions: ["other subordinate clauses"],
      id: "reason-because",
      meaning: "Why: because",
      prerequisites: [],
      realisations: [
        spoken(
          "koska + clause",
          example(
            "Mä en tuu, koska mä oon väsynyt.",
            "I'm not coming because I'm tired.",
          ),
        ),
        standard(
          "koska + clause",
          example(
            "Minä en tule, koska minä olen väsynyt.",
            "I'm not coming because I'm tired.",
          ),
        ),
      ],
      variationDimensions: ["main statement", "reason"],
    }),
    target({
      contrast: "When an event happens relative to another",
      exclusions: ["other subordinate clauses"],
      id: "time-when",
      meaning: "When: when something happens",
      prerequisites: [],
      realisations: [
        spoken(
          "kun + clause",
          example("Kun mä tuun kotiin, mä syön.", "When I come home, I eat."),
        ),
        standard(
          "kun + clause",
          example(
            "Kun minä tulen kotiin, minä syön.",
            "When I come home, I eat.",
          ),
        ),
      ],
      variationDimensions: ["event", "time clause"],
    }),
    target({
      contrast: "A condition for a statement",
      exclusions: ["other subordinate clauses"],
      id: "condition-if",
      meaning: "Under what condition: if",
      prerequisites: [],
      realisations: [
        spoken(
          "jos + clause",
          example("Jos sä tuut, mä oon iloinen.", "If you come, I'll be glad."),
        ),
        standard(
          "jos + clause",
          example(
            "Jos sinä tulet, minä olen iloinen.",
            "If you come, I'll be glad.",
          ),
        ),
      ],
      variationDimensions: ["condition", "result"],
    }),
  ],
  title: "Finnish A1",
  version: "finnish-a1-v2-unreviewed",
};
