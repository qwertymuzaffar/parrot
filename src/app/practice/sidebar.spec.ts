import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Library } from '../core/library';
import { Session } from '../core/session';
import { Sidebar } from './sidebar';

/** The texts column's width: a fifth of the window until its edge is dragged, then what it was dragged to, kept on
 * the computer and held to the room the window has (the right column's 332 px, and a centre no narrower than in the
 * smallest window). */
describe('the texts column', () => {
  let fixture: ComponentFixture<Sidebar>;
  let column: HTMLElement;

  function show() {
    fixture = TestBed.createComponent(Sidebar);
    fixture.detectChanges();
    column = fixture.nativeElement;
  }
  function windowOf(width: number) {
    (window as { innerWidth: number }).innerWidth = width;
    window.dispatchEvent(new Event('resize'));
    fixture.detectChanges();
  }
  const edge = () => column.querySelector<HTMLElement>('.edge');
  const width = () => parseFloat(column.style.width);
  const kept = () => localStorage.getItem('parrot.texts-width');
  /** takes hold of the edge, moves it by `dx` and lets go */
  function dragBy(dx: number) {
    const handle = edge()!;
    handle.dispatchEvent(new MouseEvent('pointerdown', { clientX: 500, button: 0, bubbles: true }));
    handle.dispatchEvent(new MouseEvent('pointermove', { clientX: 500 + dx, bubbles: true }));
    handle.dispatchEvent(new MouseEvent('pointerup', { clientX: 500 + dx, bubbles: true }));
    fixture.detectChanges();
  }
  function press(key: string) {
    edge()!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    fixture.detectChanges();
  }

  beforeEach(() => {
    localStorage.clear();
    (window as { innerWidth: number }).innerWidth = 1240;
    TestBed.configureTestingModule({
      providers: [
        { provide: Library, useValue: { texts: signal([]), engineState: signal('ready'), error: signal(null) } },
        { provide: Session, useValue: { text: signal(null), opening: signal(null), home: vi.fn(), open: vi.fn() } },
      ],
    });
  });

  it('takes a fifth of the window, between 200 and 236 px, until it is dragged', () => {
    show();
    expect(width()).toBe(236);
    windowOf(1100);
    expect(width()).toBe(210);
    windowOf(960);
    expect(width()).toBe(200);
  });

  it('is dragged by its edge, between 200 and 400 px, and keeps the width', () => {
    show();
    dragBy(100);
    expect(width()).toBe(336);
    expect(kept()).toBe('336');
    dragBy(500);
    expect(width()).toBe(400);
    dragBy(-900);
    expect(width()).toBe(200);
    expect(kept()).toBe('200');
  });

  it('is as wide as it was left at the next start', () => {
    localStorage.setItem('parrot.texts-width', '320');
    show();
    expect(width()).toBe(320);
  });

  it('gives up room when the window shrinks, and takes it back', () => {
    localStorage.setItem('parrot.texts-width', '400');
    show();
    // 1000 px less the right column's 332 and the centre's 428 leaves 240
    windowOf(1000);
    expect(width()).toBe(240);
    expect(kept()).toBe('400');
    windowOf(1240);
    expect(width()).toBe(400);
  });

  it('has no edge to drag in the smallest window', () => {
    (window as { innerWidth: number }).innerWidth = 960;
    show();
    expect(edge()).toBeNull();
    windowOf(1240);
    expect(edge()).not.toBeNull();
  });

  it('is moved by the keyboard, and put back by Enter or a double-click', () => {
    show();
    press('ArrowRight');
    expect(width()).toBe(252);
    press('ArrowLeft');
    expect(width()).toBe(236);
    press('End');
    expect(width()).toBe(400);
    press('Home');
    expect(width()).toBe(200);
    expect(kept()).toBe('200');
    press('Enter');
    expect(width()).toBe(236);
    expect(kept()).toBeNull();
    press('End');
    edge()!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    fixture.detectChanges();
    expect(width()).toBe(236);
  });

  it('tells a screen reader what the edge is and where it stands', () => {
    show();
    press('ArrowRight');
    const handle = edge()!;
    expect(handle.getAttribute('role')).toBe('separator');
    expect(handle.getAttribute('aria-orientation')).toBe('vertical');
    expect(handle.getAttribute('aria-valuemin')).toBe('200');
    expect(handle.getAttribute('aria-valuemax')).toBe('400');
    expect(handle.getAttribute('aria-valuenow')).toBe('252');
  });
});
