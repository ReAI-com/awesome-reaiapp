import { describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
if (typeof document === 'undefined') GlobalRegistrator.register();
import { renderSafeTemplate, applyScopedCss, validateScopedCss, validatePageMarkup } from '../src/template';

describe('developer page template boundary', () => {
  test('data cannot become HTML and active elements are removed', () => {
    const root = document.createElement('div');
    renderSafeTemplate(root, '<h2>{{company}}</h2><script>alert(1)</script><img src="https://bad.test/x"><p onclick="alert(1)">facts</p>', { company: '<img src=x onerror=alert(1)>' });
    expect(root.querySelectorAll('script,img,iframe').length).toBe(0);
    expect(root.querySelector('h2')?.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(root.querySelector('p')?.attributes.length).toBe(0);
  });
  test('CSS cannot request URLs or alter Host tokens', () => {
    const root = document.createElement('div'); root.innerHTML = '<p class="summary">facts</p>';
    expect(() => applyScopedCss(root, 'p { background: url(https://bad.test/a); }')).toThrow();
    expect(() => applyScopedCss(root, ':root { --accent: red; }')).toThrow();
    expect(() => applyScopedCss(root, '.summary { position: fixed; }')).toThrow();
    const stop = applyScopedCss(root, '.summary { font-weight: 600; padding: 8px; }');
    expect(root.querySelector<HTMLElement>('p')?.style.fontWeight).toBe('600');
    stop(); expect(root.querySelector<HTMLElement>('p')?.style.fontWeight).toBe('');
  });
  test('CSS remains inside the supplied business container', () => {
    const outside = document.createElement('p'); outside.className = 'summary'; document.body.append(outside);
    const root = document.createElement('div'); root.innerHTML = '<p class="summary">facts</p>';
    const stop = applyScopedCss(root, '.summary { color: var(--text-primary); }');
    expect(outside.style.color).toBe(''); stop(); outside.remove();
  });
  test('invalid selectors are rejected before a profile can be saved',()=>{
    for(const selector of ['.', 'div >', 'div >> p', ', p', '12div']) {
      expect(()=>validateScopedCss(`${selector} { color: red; }`)).toThrow();
    }
    expect(validateScopedCss('.summary > p.value, h2.title { color: red; }').length).toBe(1);
  });
});

test('page bindings are declared empty slots and scalar values stay outside attributes',()=>{
  const options={scalarIds:['total'],listIds:['rows']};
  expect(()=>validatePageMarkup('<h3>{{total}}</h3><div class="table" data-binding="rows"></div>',options)).not.toThrow();
  for(const html of ['<p class="{{total}}">x</p>','<div data-binding="unknown"></div>','<span data-binding="rows"></span>','<div data-binding="rows"><p>hidden</p></div>','<p>{{missing}}</p>','<div data-binding="rows"></div><div data-binding="rows"></div>']) {
    expect(()=>validatePageMarkup(html,options)).toThrow();
  }
  const root=document.createElement('div');
  renderSafeTemplate(root,'<p>{{total}}</p><div data-binding="rows"></div><div data-binding="unknown"></div>',{total:'<img src=x>'},{listIds:['rows']});
  expect(root.querySelector('p')?.textContent).toBe('<img src=x>');
  expect(root.querySelectorAll('[data-binding]').length).toBe(1);
  expect(root.querySelector('[data-binding="rows"]')).not.toBeNull();
});
