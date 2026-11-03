//! Numbers as English words, the way Kokoro's phonemizer reads them: cardinals without "and" ("one hundred twenty
//! three"), ordinals, years ("twenty twenty three", "nineteen oh five", "nineteen hundred") and decimals ("five point
//! five"). Each gives the words separated by spaces, since every word is then looked up on its own.

const ONES: [&str; 20] = [
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
];
const TENS: [&str; 10] = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES: [(u64, &str); 4] = [(1_000_000_000_000, "trillion"), (1_000_000_000, "billion"), (1_000_000, "million"), (1_000, "thousand")];

pub fn cardinal(n: u64) -> String {
    words(n).join(" ")
}

fn words(n: u64) -> Vec<&'static str> {
    if n == 0 {
        return vec!["zero"];
    }
    let mut out = vec![];
    let mut rest = n;
    for (scale, name) in SCALES {
        if rest >= scale {
            under_thousand(rest / scale, &mut out);
            out.push(name);
            rest %= scale;
        }
    }
    if rest > 0 {
        under_thousand(rest, &mut out);
    }
    out
}

fn under_thousand(n: u64, out: &mut Vec<&'static str>) {
    let (hundreds, rest) = (n / 100, n % 100);
    if hundreds > 0 {
        out.push(ONES[hundreds as usize]);
        out.push("hundred");
    }
    if rest >= 20 {
        out.push(TENS[(rest / 10) as usize]);
        if rest % 10 > 0 {
            out.push(ONES[(rest % 10) as usize]);
        }
    } else if rest > 0 {
        out.push(ONES[rest as usize]);
    }
}

/// "first", "twenty first", "hundredth": the last word takes the ordinal form.
pub fn ordinal(n: u64) -> String {
    let mut out: Vec<String> = words(n).into_iter().map(String::from).collect();
    if let Some(last) = out.pop() {
        out.push(match last.as_str() {
            "one" => "first".into(),
            "two" => "second".into(),
            "three" => "third".into(),
            "five" => "fifth".into(),
            "eight" => "eighth".into(),
            "nine" => "ninth".into(),
            "twelve" => "twelfth".into(),
            word if word.ends_with("ty") => format!("{}ieth", &word[..word.len() - 1]),
            word => format!("{word}th"),
        });
    }
    out.join(" ")
}

/// A four-digit year as it is said: "nineteen ninety nine", "twenty twenty three", "nineteen oh five", "nineteen
/// hundred"; a round thousand and the nine years after it, "two thousand five", as the plain number.
pub fn year(n: u64) -> String {
    let (high, low) = (n / 100, n % 100);
    if high % 10 == 0 && low < 10 {
        return cardinal(n);
    }
    let mut out = words(high);
    if low == 0 {
        out.push("hundred");
    } else if low < 10 {
        out.push("oh");
        out.push(ONES[low as usize]);
    } else {
        out.extend(words(low));
    }
    out.join(" ")
}

/// "5.50" as "five point five", "3.14" as "three point one four", "2.05" as "two point zero five": the whole part as a
/// number, the fraction digit by digit, with its trailing zeros dropped but one digit kept.
pub fn decimal(whole: &str, fraction: &str) -> String {
    let mut out = whole.parse::<u64>().map(words).unwrap_or_else(|_| whole.chars().filter_map(digit).collect());
    out.push("point");
    let trimmed = fraction.trim_end_matches('0');
    let fraction = if trimmed.is_empty() { "0" } else { trimmed };
    out.extend(fraction.chars().filter_map(digit));
    out.join(" ")
}

fn digit(character: char) -> Option<&'static str> {
    character.to_digit(10).map(|value| ONES[value as usize])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cardinals_have_no_and() {
        assert_eq!(cardinal(0), "zero");
        assert_eq!(cardinal(12), "twelve");
        assert_eq!(cardinal(21), "twenty one");
        assert_eq!(cardinal(100), "one hundred");
        assert_eq!(cardinal(123), "one hundred twenty three");
        assert_eq!(cardinal(1_500), "one thousand five hundred");
        assert_eq!(cardinal(1_000_000), "one million");
        assert_eq!(cardinal(2_030_040), "two million thirty thousand forty");
    }

    #[test]
    fn ordinals_change_their_last_word() {
        assert_eq!(ordinal(1), "first");
        assert_eq!(ordinal(3), "third");
        assert_eq!(ordinal(4), "fourth");
        assert_eq!(ordinal(12), "twelfth");
        assert_eq!(ordinal(20), "twentieth");
        assert_eq!(ordinal(21), "twenty first");
        assert_eq!(ordinal(100), "one hundredth");
        assert_eq!(ordinal(101), "one hundred first");
        assert_eq!(ordinal(1000), "one thousandth");
    }

    #[test]
    fn years_are_said_in_pairs() {
        assert_eq!(year(1999), "nineteen ninety nine");
        assert_eq!(year(2023), "twenty twenty three");
        assert_eq!(year(1905), "nineteen oh five");
        assert_eq!(year(1900), "nineteen hundred");
        assert_eq!(year(2100), "twenty one hundred");
        assert_eq!(year(2000), "two thousand");
        assert_eq!(year(2005), "two thousand five");
        assert_eq!(year(1066), "ten sixty six");
    }

    #[test]
    fn decimals_are_read_digit_by_digit_after_the_point() {
        assert_eq!(decimal("5", "50"), "five point five");
        assert_eq!(decimal("3", "14"), "three point one four");
        assert_eq!(decimal("2", "05"), "two point zero five");
        assert_eq!(decimal("1", "0"), "one point zero");
        assert_eq!(decimal("12", ""), "twelve point zero");
    }
}
