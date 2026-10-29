// Each preview has its own source and story; the global capsule belongs to Host.
export const previews = [
  {id:'voice',appId:'com.reai.voice',key:'home.preview.voice',steps:4,beats:[0,3.3,12.2,20.2]},
  {id:'browser',appId:'com.reai.browser',key:'home.preview.browser',steps:3,beats:[0,4,6.5]},
  {id:'terminal',appId:'com.reai.terminal',key:'home.preview.terminal',steps:3,beats:[0,2,5.5]},
];

export function previewAsset(preview,extension,version='') {
  return `/assets/previews/${preview.id}.${extension}${version?'?v='+encodeURIComponent(version):''}`;
}
