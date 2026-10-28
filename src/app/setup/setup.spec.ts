import { TestBed } from '@angular/core/testing';
import { Engine, EngineError, EngineInfo } from '../core/engine';
import { Setup } from './setup';

const INFO: EngineInfo = {
  data: '/data',
  models: { whisper: false, aligner: false },
  sizes: { whisper: 480_000_000, aligner: 380_000_000 },
};

describe('the first launch', () => {
  it('says why a download failed under the button, so Try again is where Download was', async () => {
    const engine = { downloadModels: vi.fn().mockRejectedValue(new EngineError('The connection was lost')) };
    TestBed.configureTestingModule({ providers: [{ provide: Engine, useValue: engine }] });
    const fixture = TestBed.createComponent(Setup);
    fixture.componentRef.setInput('info', INFO);
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    const button = element.querySelector<HTMLButtonElement>('.btn.primary')!;
    const before = [...element.querySelectorAll('.box > *')].indexOf(button);
    button.click();
    await fixture.whenStable();
    const error = element.querySelector('.error')!;
    expect([button.textContent!.trim(), error.textContent]).toEqual([
      'Try again',
      'The connection was lost. Check your internet connection and try again.',
    ]);
    // nothing new above the button: it stays put
    expect([...element.querySelectorAll('.box > *')].indexOf(button)).toBe(before);
    expect(button.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
