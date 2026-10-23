import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { EngineError } from '../core/engine';
import { Library } from '../core/library';
import { Playback } from '../core/playback';
import { Recorder } from '../core/recorder';
import { Session } from '../core/session';
import { WordPractice } from '../core/word-practice';
import { EditWords } from './edit-words';

describe('editing the words of a text', () => {
  const session = {
    text: signal({ id: 'abcdef0123', text: 'Hello there. How are you?' }),
    index: signal(1),
    open: vi.fn(),
    checking: signal(false),
  };
  const library = { editText: vi.fn() };
  const recorder = { owner: signal<string | null>(null) };
  const wordPractice = { checking: signal(false) };

  beforeEach(() => {
    vi.clearAllMocks();
    // jsdom has no modal dialogs: open and close are enough here
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.open = false;
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: Session, useValue: session },
        { provide: Library, useValue: library },
        { provide: Playback, useValue: { stop: vi.fn() } },
        { provide: Recorder, useValue: recorder },
        { provide: WordPractice, useValue: wordPractice },
      ],
    });
  });

  async function editor() {
    const fixture = TestBed.createComponent(EditWords);
    await fixture.whenStable();
    fixture.componentInstance.open();
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    const textarea = element.querySelector('textarea')!;
    const save = () => [...element.querySelectorAll('button')].find((each) => /Save/.test(each.textContent!))!.click();
    return { fixture, element, textarea, save, dialog: element.querySelector('dialog')! };
  }

  it('saves the words changed, saying how far the tries are scored again, and opens the text again where it was', async () => {
    let finish!: () => void;
    library.editText.mockImplementation((_id, _words, onProgress) => {
      onProgress(1, 3);
      return new Promise<void>((resolve) => (finish = resolve));
    });
    const { fixture, element, textarea, save, dialog } = await editor();
    expect([dialog.open, textarea.value]).toEqual([true, 'Hello there. How are you?']);
    textarea.value = 'Hello there. How old are you?';
    textarea.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    save();
    await fixture.whenStable();
    expect(library.editText.mock.calls[0].slice(0, 2)).toEqual(['abcdef0123', 'Hello there. How old are you?']);
    expect(element.querySelector('[role=status]')!.textContent).toContain('Scoring the tries again: 1 of 3');
    expect(textarea.disabled).toBe(true);
    finish();
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
    expect(session.open).toHaveBeenCalledWith('abcdef0123', 1);
    expect(dialog.open).toBe(false);
  });

  it('says why the words could not be changed, and keeps them to try again', async () => {
    library.editText.mockRejectedValue(new EngineError('the speech engine is not running'));
    const { fixture, element, textarea, save, dialog } = await editor();
    textarea.value = 'Hello there.';
    textarea.dispatchEvent(new Event('input'));
    save();
    await fixture.whenStable();
    expect(element.querySelector('[role=alert]')!.textContent).toContain('the speech engine is not running');
    expect([dialog.open, textarea.value, textarea.disabled]).toEqual([true, 'Hello there.', false]);
  });

  it('waits while a take is recorded or checked, which would be filed under the words as they were', async () => {
    const { fixture, element, save } = await editor();
    expect(fixture.componentInstance.taking()).toBe(false);
    for (const busy of [() => session.checking.set(true), () => wordPractice.checking.set(true), () => recorder.owner.set('part')]) {
      busy();
      expect(fixture.componentInstance.taking()).toBe(true);
      save();
      await fixture.whenStable();
      expect(library.editText).not.toHaveBeenCalled();
      expect(element.querySelector('[role=alert]')!.textContent).toContain('A take is being checked');
      session.checking.set(false);
      wordPractice.checking.set(false);
      recorder.owner.set(null);
    }
  });
});
