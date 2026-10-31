import { Menu } from './menu';

describe('the app menu in the window', () => {
  it('tells each listener of an item chosen, until it stops listening', () => {
    const menu = new Menu();
    const heard: string[] = [];
    const off = menu.on((action) => heard.push('a:' + action));
    menu.on((action) => heard.push('b:' + action));
    menu.fire('new');
    off();
    menu.fire('find');
    expect(heard).toEqual(['a:new', 'b:new', 'b:find']);
  });

  it('has nothing to take or tell in a plain browser', async () => {
    const menu = new Menu();
    await expect(menu.connect()).resolves.toBeUndefined();
    expect(() => menu.screen('home')).not.toThrow();
  });
});
