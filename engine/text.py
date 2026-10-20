"""Compare what was read with what the speech recognizer heard, word by word.

Both sides are turned into the same tokens first: lower case, no punctuation, and numbers as digits whichever way they
were written ("nineteen fifty-nine", "1959" -> "#1959"), so only real differences count.
"""
import difflib
import re

UNITS = {word: value for value, word in enumerate("zero one two three four five six seven eight nine ten eleven twelve thirteen "
                                    "fourteen fifteen sixteen seventeen eighteen nineteen".split())}
TENS = {word: 10 * digit for digit, word in enumerate("twenty thirty forty fifty sixty seventy eighty ninety".split(), 2)}
# "second" is left out on purpose: it is far more often the time unit ("twenty seconds") than the ordinal
ORDINALS = {"first": 1, "third": 3, "fourth": 4, "fifth": 5, "sixth": 6, "seventh": 7, "eighth": 8,
            "ninth": 9, "tenth": 10, "eleventh": 11, "twelfth": 12, "thirteenth": 13, "fourteenth": 14, "fifteenth": 15,
            "sixteenth": 16, "seventeenth": 17, "eighteenth": 18, "nineteenth": 19, "twentieth": 20, "thirtieth": 30,
            "fortieth": 40, "fiftieth": 50, "sixtieth": 60, "seventieth": 70, "eightieth": 80, "ninetieth": 90}
SCALES = {"hundred": 100, "thousand": 1000, "million": 10 ** 6, "billion": 10 ** 9, "trillion": 10 ** 12}

# words that are the same thing said two ways (script spelling / whisper spelling), or that whisper drops
SAME = {"it's": "its", "percent": "", "%": "", "dollars": "", "dollar": "",
        "fahrenheit": "f", "degrees": "", "okay": "ok", "a.i": "ai",
        # British spelling in the text; whisper small.en writes American
        "kilometres": "kilometers", "metres": "meters", "litres": "liters", "centimetres": "centimeters", "grey": "gray",
        "colour": "color", "colours": "colors", "plough": "plow", "ploughs": "plows", "centre": "center", "programme": "program",
        "favourite": "favorite", "aluminium": "aluminum", "travelled": "traveled", "travelling": "traveling", "fibre": "fiber",
        "theatre": "theater", "defence": "defense", "licence": "license", "neighbour": "neighbor", "honour": "honor",
        "behaviour": "behavior", "catalogue": "catalog", "organise": "organize", "realise": "realize", "recognise": "recognize",
        "analyse": "analyze", "manoeuvre": "maneuver", "sulphur": "sulfur", "practise": "practice", "mould": "mold", "storey": "story"}


def _is_digits(tok):
    return re.fullmatch(r"\d+(?:[.,]\d+)*(?:st|nd|rd|th)?", tok) is not None


def _numeric(tok):
    return tok in UNITS or tok in TENS or tok in ORDINALS or tok in SCALES or _is_digits(tok)


def _compose(run):
    """A run of number tokens (words or digits) as one canonical digit string.

    "sixty eight" -> 68, "nineteen eighty six" -> 1986, "twenty twenty four" -> 2024, "three thirty" -> 330,
    "a hundred and fifty thousand" -> 150000, "one point three million" -> 1300000, "twenty first" -> 21,
    and the same strings from whisper's digits ("68", "1986", "2024", "3:30" -> "3","30", "150,000", "1.3 million", "21st").
    Juxtaposed groups (year, clock time) are concatenated; groups after the first are zero-padded to two digits.
    """
    groups, cur, total, frac, prev = [], 0, 0, None, None   # prev: kind of the last number word

    def fold():
        """Fold the digits heard after "point" into the current number: "one point three" -> 1.3."""
        nonlocal cur, frac
        if frac:
            cur = float(f"{int(cur)}.{frac}")
        frac = None

    for tok in run:
        if tok in ("a", "and"):
            if tok == "a":
                cur, prev = 1, "unit"
            continue
        if tok == "point":
            frac = ""
            continue
        if _is_digits(tok):
            value = re.sub(r"(st|nd|rd|th)$", "", tok).replace(",", "")
            if re.fullmatch(r"\d{1,2}\.[0-5]\d", value):  # whisper writes "three-thirty" as "3.30": a clock time, not 3.3
                value = value.replace(".", "")
            value = float(value) if "." in value else int(value)
            kind = "digits"
        elif tok in SCALES:
            fold()
            scale = SCALES[tok]
            if scale == 100:
                cur = (cur or 1) * 100
            else:
                total += (cur or 1) * scale
                cur = 0
            prev = "scale"
            continue
        else:
            value = UNITS.get(tok, TENS.get(tok, ORDINALS.get(tok)))
            kind = "tens" if tok in TENS else "unit"
        if frac is not None:                       # digits after "point" (a decimal's whole part, as the Rust engine)
            frac += str(int(value))
            continue
        # a new juxtaposed group when a number follows a number that cannot combine with it (19 | 86, 20 | 24, 3 | 30)
        if prev in ("unit", "tens", "digits") and not (prev == "tens" and kind == "unit" and value < 10):
            groups.append(total + cur)
            total, cur = 0, 0
        cur += value
        prev = kind
    fold()
    groups.append(total + cur)
    if len(groups) == 1:
        number = groups[0]
        return f"{number:.6f}".rstrip("0").rstrip(".") if isinstance(number, float) and number != int(number) \
            else str(int(number))
    out = str(int(groups[0]))
    for group in groups[1:]:
        out += f"{int(group):02d}"
    return out


def toks(phrase):
    """Lower-case word tokens; runs of number words or digits become one '#digits' token."""
    phrase = phrase.lower().replace("’", "'").replace("-", " ").replace(":", " ")
    raw = re.findall(r"\d+(?:[.,]\d+)*(?:st|nd|rd|th)?|[a-z][a-z'.]*", phrase)
    words = []
    for word in raw:
        word = word.strip("'.")                            # quote marks and full stops stuck to a word ('pancake')
        if word.endswith("'s") and not _numeric(word[:-2]):
            word = word[:-2]
        word = SAME.get(word, word)
        if word and not _numeric(word) and word.endswith("s"):  # "eighteens" / whisper "18s", "nineties" / "90s", "hundreds"
            stem = word[:-1]
            if stem.endswith("ie") and stem[:-2] + "y" in TENS:
                stem = stem[:-2] + "y"
            if stem in UNITS or stem in TENS or stem in SCALES or _is_digits(stem):   # not ordinals: "thirds", "fifths" are words
                words += [stem, "s"]
                continue
        if word:
            words.append(word)
    out, position = [], 0
    while position < len(words):
        word = words[position]
        nxt = words[position + 1] if position + 1 < len(words) else ""
        starts = _numeric(word) or (word == "a" and nxt in SCALES)
        if not starts:
            out.append(word)
            position += 1
            continue
        run = []
        while position < len(words):
            word, nxt = words[position], (words[position + 1] if position + 1 < len(words) else "")
            if _numeric(word) or (word == "a" and nxt in SCALES and not run) \
                    or (word == "and" and run and _numeric(nxt)) \
                    or (word == "point" and run and (nxt in UNITS or _is_digits(nxt))):
                run.append(word)
                position += 1
            else:
                break
        out.append("#" + _compose(run))
    return out


def diff_ops(script_tokens, heard_tokens):
    """Opcodes where the two token lists really differ (joined spellings like 'light day' / 'lightday' are not differences)."""
    return [op for op in difflib.SequenceMatcher(None, script_tokens, heard_tokens, autojunk=False).get_opcodes()
            if op[0] != "equal" and "".join(script_tokens[op[1]:op[2]]) != "".join(heard_tokens[op[3]:op[4]])]



def pair_up(xs, ys, floor=0.4):
    """{index in xs: index in ys}: an in-order pairing that maximises how alike the paired words are
    (difflib ratio; pairs below floor are not made)."""
    sim = [[difflib.SequenceMatcher(None, x_word, y_word).ratio() for y_word in ys] for x_word in xs]
    best = [[0.0] * (len(ys) + 1) for _ in range(len(xs) + 1)]
    for x_index in range(len(xs) - 1, -1, -1):
        for y_index in range(len(ys) - 1, -1, -1):
            take = sim[x_index][y_index] + best[x_index + 1][y_index + 1] if sim[x_index][y_index] >= floor else -1
            best[x_index][y_index] = max(take, best[x_index + 1][y_index], best[x_index][y_index + 1])
    out, x_index, y_index = {}, 0, 0
    while x_index < len(xs) and y_index < len(ys):
        if sim[x_index][y_index] >= floor \
                and best[x_index][y_index] == sim[x_index][y_index] + best[x_index + 1][y_index + 1]:
            out[x_index] = y_index
            x_index, y_index = x_index + 1, y_index + 1
        elif best[x_index][y_index] == best[x_index + 1][y_index]:
            x_index += 1
        else:
            y_index += 1
    return out


def heard_words(text, heard):
    """For each script word: None if whisper heard it, else what it heard instead ("" = nothing).
    Plus the extra words whisper heard after each script word."""
    script_words = text.split()
    # which script word owns each token: numbers spelled over several words become one token ("nineteen fifty-nine")
    owner, owned_count = [], 0
    for word_index in range(len(script_words)):
        prefix_count = len(toks(" ".join(script_words[:word_index + 1])))
        owner += [word_index] * (prefix_count - owned_count)
        owned_count = max(owned_count, prefix_count)
    script_tokens, heard_tokens = toks(text), toks(heard)
    wrong, extra = [None] * len(script_words), [""] * len(script_words)
    if not script_words:
        return wrong, extra
    for op, i1, i2, j1, j2 in diff_ops(script_tokens, heard_tokens):
        said = " ".join(heard_tokens[j1:j2]).replace("#", "")
        if op == "insert":
            word_index = owner[i1 - 1] if i1 else 0
            extra[word_index] = (extra[word_index] + " " + said).strip()
            continue
        if op == "delete":
            for token_index in range(i1, i2):
                wrong[owner[token_index]] = ""
            continue
        # a replaced stretch: pair each script token with the heard token that sounds most like it, in order
        # ("suite of about two hundred tests" heard as "suit": only "suite" gets "suit", the rest were not heard)
        pairs = pair_up(script_tokens[i1:i2], heard_tokens[j1:j2])
        for token_index in range(i1, i2):
            word_index = owner[token_index]
            heard_offset = pairs.get(token_index - i1)
            heard_as = heard_tokens[j1 + heard_offset].replace("#", "") if heard_offset is not None else ""
            wrong[word_index] = (wrong[word_index] + " " + heard_as).strip() if wrong[word_index] else heard_as
        paired = set(pairs.values())
        for heard_offset in range(j2 - j1):
            if heard_offset not in paired:      # heard but matching no script word: an extra after the word before it
                before = [script_offset for script_offset, paired_offset in pairs.items() if paired_offset < heard_offset]
                word_index = owner[i1 + max(before)] if before else (owner[i1 - 1] if i1 else owner[i1])
                extra[word_index] = (extra[word_index] + " " + heard_tokens[j1 + heard_offset].replace("#", "")).strip()
    # words that own no token of their own share the verdict of the word before (the "fifty-nine" of "nineteen fifty-nine")
    owned = set(owner)
    for word_index in range(1, len(script_words)):
        if word_index not in owned:
            wrong[word_index] = wrong[word_index - 1]
    return wrong, extra


def judge(text, heard, mine, ref):
    """Per-word verdicts: good, unclear (amber) or wrong (red)."""
    wrong, extra = heard_words(text, heard)
    words = []
    for word_index, word in enumerate(text.split()):
        score, ref_score = mine[word_index]["score"], (ref[word_index]["score"] if ref else None)
        status = "good"
        if wrong[word_index] is not None:
            status = "wrong"
        elif score is not None:
            if ref_score is not None and score < 0.75 and ref_score - score > 0.2:
                status = "unclear"
            elif ref_score is None and score < 0.5:
                status = "unclear"
        words.append({"w": word, "t": mine[word_index]["t"], "score": score, "ref": ref_score, "status": status,
                      "heard": wrong[word_index], "extra": extra[word_index]})
    return words
