import { OPERATIONS_ROLES } from './roles-operations';
import { PEOPLE_ROLES } from './roles-people';
import { LEADERSHIP_ROLES } from './roles-leadership';
import type { Role } from './types';

export const ROLES: Role[] = [...OPERATIONS_ROLES, ...PEOPLE_ROLES, ...LEADERSHIP_ROLES];
export const PUBLIC_SOURCES = [
  { title: '巴奴官网 · 产品主义与菜品', url: 'https://www.banu.cn/zh-CN#eleproduct', note: '品牌语境、经典毛肚、野山菌汤、绣球菌等菜名' },
  { title: '新华网 · 原阳央厨报道', url: 'https://www.xinhuanet.com/finance/20250326/dde7f0fd054448a5a8468e611d7c7007/c.html', note: '供应链场景的公开背景' },
  { title: '杨浦融媒 · 上海合生汇店', url: 'https://m.thepaper.cn/newsDetail_forward_33424045', note: '公开门店名称与地点' },
];
