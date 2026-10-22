/** Something to talk about: a few sets of questions, one shown at a time on the Just talk card. */
export interface PromptSet {
  key: string;
  label: string;
  prompts: string[];
}

export const PROMPT_SETS: PromptSet[] = [
  {
    key: 'interview',
    label: 'Interview',
    prompts: [
      'Tell me about yourself.',
      'Why do you want this job?',
      'Describe a problem you solved at work.',
      'What are you most proud of?',
      'Tell me about a time you disagreed with someone.',
      'What is your greatest strength?',
      'Where do you see yourself in five years?',
      'Tell me about a mistake you made, and what you learned.',
      'How do you handle pressure?',
      'Why should we hire you?',
    ],
  },
  {
    key: 'small-talk',
    label: 'Small talk',
    prompts: [
      'How was your weekend?',
      'Where did you grow up?',
      'What do you do in your free time?',
      'Tell me about the last trip you took.',
      'What is a film or a book you liked recently?',
      'What do you like to cook?',
      'What does a normal day look like for you?',
      'Tell me about your family.',
      'What is the best place you have lived?',
      'What are you looking forward to this year?',
    ],
  },
  {
    key: 'presentations',
    label: 'Presentations',
    prompts: [
      'Introduce a project you worked on.',
      'Explain your job to someone outside your field.',
      'Give a short update on what your team did this week.',
      'Present an idea to make your workplace better.',
      'Explain how something you use every day works.',
      'Pitch a product you love.',
      'Sum up an article or a talk you found interesting.',
      'Walk through the steps of a process you know well.',
      'Make the case for a decision you want your team to take.',
      'Introduce yourself to a new team.',
    ],
  },
];

/** A prompt of `set` other than `now` (when it has another), picked at random. */
export function pick(set: PromptSet, now: string | null, random = Math.random) {
  const others = set.prompts.filter((prompt) => prompt !== now);
  return others[Math.floor(random() * others.length)] ?? set.prompts[0];
}

/** A prompt as a text's title: without its full stop. */
export function asTitle(prompt: string) {
  return prompt.replace(/\.$/, '');
}
