import './showcase/styles.css';
import { ROLES } from './showcase/catalog';
import { MockStore } from './showcase/state';
import { Showcase } from './showcase/view';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('展示容器不存在');
new Showcase(root, ROLES, new MockStore(ROLES)).mount();
