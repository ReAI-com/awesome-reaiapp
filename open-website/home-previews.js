// Each preview has its own source and story; the global capsule belongs to Host.
export const previews = [
  {id:'voice',appId:'com.reai.voice',key:'home.preview.voice',beats:[0,2.9,3.6]},
  {id:'browser',appId:'com.reai.browser',key:'home.preview.browser',beats:[0,4,6.5]},
  {id:'terminal',appId:'com.reai.terminal',key:'home.preview.terminal',beats:[0,2,5.5]},
];

export function previewAsset(preview,extension,version='') {
  return `/assets/previews/${preview.id}.${extension}${version?'?v='+encodeURIComponent(version):''}`;
}
