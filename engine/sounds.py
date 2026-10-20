"""How a word sounds, from the CMU Pronouncing Dictionary: a respelling with the stressed syllable marked
("an·SR" for answer, the way Google shows it) and its IPA.

CMUdict (BSD-style licence, about 135,000 words, American English) is downloaded into the models folder on first use.
"""
import os
import re
import subprocess

import paths

CMUDICT = os.path.join(paths.MODELS, "cmudict.dict")
CMUDICT_URL = "https://raw.githubusercontent.com/cmusphinx/cmudict/master/cmudict.dict"
_cmu = None
VOWELS = {"AA": ("aa", "ɑ"), "AE": ("a", "æ"), "AH": ("uh", "ʌ"), "AO": ("aw", "ɔ"), "AW": ("ow", "aʊ"), "AY": ("ai", "aɪ"),
          "EH": ("eh", "ɛ"), "ER": ("ur", "ɝ"), "EY": ("ay", "eɪ"), "IH": ("i", "ɪ"), "IY": ("ee", "i"), "OW": ("oh", "oʊ"),
          "OY": ("oy", "ɔɪ"), "UH": ("u", "ʊ"), "UW": ("oo", "u")}
CONS = {"B": "b", "CH": ("ch", "tʃ"), "D": "d", "DH": ("dh", "ð"), "F": "f", "G": ("g", "ɡ"), "HH": "h", "JH": ("j", "dʒ"),
        "K": "k", "L": "l", "M": "m", "N": "n", "NG": ("ng", "ŋ"), "P": "p", "R": ("r", "ɹ"), "S": "s", "SH": ("sh", "ʃ"),
        "T": "t", "TH": ("th", "θ"), "V": "v", "W": "w", "Y": ("y", "j"), "Z": "z", "ZH": ("zh", "ʒ")}
ONSETS = {tuple(onset.split()) for onset in (
    "P R|P L|B R|B L|T R|D R|K R|K L|G R|G L|F R|F L|TH R|SH R|S P|S T|S K|S M|S N|S L|S W|T W|D W|K W|G W|TH W|"
    "S P R|S T R|S K R|S P L|S K W|P Y|B Y|K Y|F Y|M Y|V Y|HH Y|G Y|S K Y|S P Y").split("|")}


def cmu():
    """{word: [phones of the first pronunciation]}, downloaded once into the cache."""
    global _cmu
    if _cmu is None:
        if not os.path.exists(CMUDICT):
            os.makedirs(os.path.dirname(CMUDICT), exist_ok=True)
            subprocess.run(["curl", "-sSfL", "-o", CMUDICT, CMUDICT_URL], check=True)
        _cmu = {}
        with open(CMUDICT, encoding="utf-8", errors="ignore") as lines:
            for line in lines:
                parts = line.split("#")[0].split()
                if parts and "(" not in parts[0]:
                    _cmu[parts[0]] = parts[1:]
    return _cmu


def syllables(phones):
    """[(onset+nucleus+coda phones, stress)]: every vowel a syllable, consonants between two vowels given to the
    second as the longest legal English onset ("six-teen" S IH K | S T IY N)."""
    vowels = [index for index, phone in enumerate(phones) if phone[-1].isdigit()]
    if not vowels:
        return [(phones, None)]
    cuts = [0]
    for vowel, next_vowel in zip(vowels, vowels[1:]):
        mid = phones[vowel + 1:next_vowel]
        onset_length = 0
        for length in range(len(mid), 0, -1):
            if length == 1 and mid[-1] != "NG" or tuple(mid[-length:]) in ONSETS:
                onset_length = length
                break
        cuts.append(next_vowel - onset_length)
    cuts.append(len(phones))
    return [(phones[start:end], int(phones[vowel][-1])) for start, end, vowel in zip(cuts, cuts[1:], vowels)]


def sounds_like(word):
    """{"spell": [[syllable, stressed?], ...], "ipa": "/ˈæn.sɚ/"} or None for a word not in the dictionary."""
    dictionary = cmu()
    parts = [piece for piece in re.split(r"[-–—/]", word.lower().replace("’", "'")) if piece]
    spell, ipas = [], []
    for part in parts:
        ipa = []
        bare = re.sub(r"[^a-z']", "", part).strip("'")
        phones = dictionary.get(bare)
        if phones is None:
            return None
        for syl, stress in syllables(phones):
            syl_spell, syl_ipa = "", ""
            for index, phone in enumerate(syl):
                base, digit = (phone[:-1], phone[-1]) if phone[-1].isdigit() else (phone, None)
                if digit is None:
                    consonant = CONS[base]
                    syl_spell = syl_spell + (consonant if isinstance(consonant, str) else consonant[0])
                    syl_ipa = syl_ipa + (consonant if isinstance(consonant, str) else consonant[1])
                    continue
                vowel_spell, vowel_ipa = VOWELS[base]
                rest = syl[index + 1:]
                if digit == "0":
                    if base == "ER":
                        vowel_spell, vowel_ipa = "r", "ɚ"
                    elif base == "AH":
                        # a weak "uh" before a final n or l after a consonant is the syllabic n/l ("shn", "tl")
                        vowel_spell, vowel_ipa = ("", "ə") if rest in (["N"], ["L"]) and index > 0 else ("uh", "ə")
                    elif base == "IH":
                        vowel_ipa = "ɪ"
                syl_spell, syl_ipa = syl_spell + vowel_spell, syl_ipa + vowel_ipa
            spell.append([syl_spell, stress == 1])
            ipa.append(("ˈ" if stress == 1 else "ˌ" if stress == 2 else "") + syl_ipa)
        ipas.append(".".join(ipa).replace(".ˈ", "ˈ").replace(".ˌ", "ˌ"))
    return {"spell": spell, "ipa": "/" + " ".join(ipas) + "/"}
