export const restaurantStyles = String.raw`
.restaurant-hero{padding:26px;border:1px solid var(--divider);border-radius:14px;background:var(--card-bg);margin:0 0 20px;position:relative;overflow:hidden}
.restaurant-eyebrow{font-size:11px;letter-spacing:.12em;color:var(--accent);font-weight:700;margin-bottom:10px}
.restaurant-hero h1{font-size:27px;line-height:1.35;margin:0 0 10px;letter-spacing:-.6px}
.restaurant-hero p{font-size:13px;line-height:1.8;color:var(--text-secondary);max-width:620px;margin:0 0 16px}
.restaurant-stats{display:flex;gap:24px;flex-wrap:wrap;padding-top:16px;border-top:1px solid var(--divider)}
.restaurant-stats b{font-size:22px;font-variant-numeric:tabular-nums;display:block;color:var(--text-primary)}
.restaurant-stats span{font-size:11px;color:var(--text-secondary)}
.restaurant-roles{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:22px}
.restaurant-role{display:flex;flex-direction:column;gap:12px;text-align:left;background:var(--card-bg);border:1px solid var(--divider);border-radius:12px;padding:17px;color:var(--text-primary);min-width:0}
.restaurant-role:hover{border-color:var(--accent);box-shadow:0 3px 14px rgb(110 86 207 / .08)}
.restaurant-role .top{display:flex;align-items:center;gap:10px;font-size:14px;font-weight:650}
.restaurant-role p{margin:0;color:var(--text-secondary);font-size:12px;line-height:1.65;min-height:38px}
.restaurant-role .bottom{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--text-secondary);margin-top:auto}
.restaurant-role .bottom .arrow{margin-left:auto;color:var(--accent)}
.restaurant-group-head{display:flex;align-items:center;gap:10px;margin:24px 0 12px;font-size:13px}
.restaurant-group-head small{font-weight:400;color:var(--text-secondary)}
.restaurant-task-links{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 18px}
.restaurant-evidence{padding:14px;border:1px solid var(--divider);border-radius:12px}
.restaurant-evidence>summary{cursor:pointer;font-size:13px;font-weight:600;padding:4px}
.restaurant-section{margin-top:20px}.restaurant-section .sec-head{align-items:flex-start}
.restaurant-section h2{font-size:14px}.restaurant-section .tbl th,.restaurant-section .tbl td{white-space:normal;min-width:100px;max-width:320px;overflow-wrap:anywhere}
.restaurant-section .tbl .cell-title{min-width:155px}
.restaurant-scope{margin-bottom:16px}.restaurant-gap-list{padding-left:18px;font-size:12px;line-height:1.8}
.restaurant-compare{display:flex;gap:10px;flex-wrap:wrap}.restaurant-compare a{color:var(--accent);font-size:12px;text-decoration:underline;text-underline-offset:3px}
.restaurant-disclaimer{font-size:11px;color:var(--text-secondary);line-height:1.7;margin:12px 0}
@media(max-width:719px){.restaurant-hero{padding:18px}.restaurant-hero h1{font-size:23px}.restaurant-roles{grid-template-columns:1fr}.restaurant-stats{gap:18px}.db-brand .badge{display:none}.db-brand [data-act="restaurant-gap"]{display:none}}
`;
