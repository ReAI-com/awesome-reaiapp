"""Verify the directly rendered official design before video encoding. Requires Pillow."""
from pathlib import Path
from PIL import Image, ImageChops, ImageStat, ImageDraw, ImageFilter
import json
import math
import sys

root=Path(sys.argv[1]);capture=json.loads((root/'capture.json').read_text())
def frame(index):return Image.open(root/'frames'/f'{index:05d}.png').convert('RGB')
def equal(a,b):return ImageChops.difference(a,b).getbbox() is None
def psnr(a,b):
 rms=ImageStat.Stat(ImageChops.difference(a,b)).rms;mse=sum(v*v for v in rms)/len(rms)
 return 'inf' if mse==0 else round(10*math.log10(255*255/mse),3)
empty=frame(0);still=Image.open(root/'still.png').convert('RGB');reference=Image.open(root/'reference.png').convert('RGB')
# The app's original rectangular content regions clip their stories. Outer app corners never move.
mask=Image.new('L',empty.size,0);draw=ImageDraw.Draw(mask);scale=capture['deviceScaleFactor']
for r in capture['geometry']:
 draw.rectangle(tuple(round(v*scale) for v in (r['x'],r['y'],r['x']+r['width'],r['y']+r['height'])),fill=255)
outside=ImageChops.invert(mask.filter(ImageFilter.MaxFilter(5)))
overflow=[]
for index in range(144,630):
 diff=ImageChops.difference(frame(index),still)
 if any(ImageChops.multiply(channel,outside).getbbox() is not None for channel in diff.split()):overflow.append(index)
 if index%180==0:print(f'Checked frame {index}/629',flush=True)
empty_failures=[index for index in range(678,720) if not equal(empty,frame(index))]
report={'reference':capture['reference'],'source_sha256':capture['sourceSha256'],'fidelity_psnr_db':psnr(reference,still),'seam_exact':equal(empty,frame(720)),'rest_exact':equal(still,frame(629)),'rest_psnr_db':psnr(still,frame(629)),'empty_beat_frames_checked':42,'empty_beat_failures':empty_failures,'overflow_story_frames_checked':486,'overflow_failures':overflow,'capture_errors':capture['errors']}
sheet=Image.new('RGB',(1920,948),'#fafbf8');draw=ImageDraw.Draw(sheet)
for tile,index in enumerate([0,24,60,144,180,240,300,360,480,629,654,696]):
 x,y=(tile%4)*480,(tile//4)*316;sheet.paste(frame(index).resize((480,284),Image.Resampling.LANCZOS),(x,y));draw.text((x+12,y+294),f'{index/60:.2f}s / frame {index}',fill='#20271d')
sheet.save(root/'contact-sheet.jpg',quality=94)
(root/'verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps(report,ensure_ascii=False,indent=2),flush=True)
assert report['seam_exact'],'Loop seam changed'
assert report['rest_exact'],'Original design was not restored before dissolve'
assert not empty_failures,'Content remains after dissolve'
assert not overflow,'Pixels changed outside the original content surfaces'
assert not capture['errors'],'Browser runtime errors'
