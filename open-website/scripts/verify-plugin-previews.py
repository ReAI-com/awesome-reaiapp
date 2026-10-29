"""Check source rendering, loop reset and original surface bounds before encoding."""
from pathlib import Path
from PIL import Image, ImageChops, ImageFilter, ImageDraw
import json, sys

root=Path(sys.argv[1]); data=json.loads((root/'capture.json').read_text())
def frame(i): return Image.open(root/'frames'/f'{i:05d}.png').convert('RGB')
def same(a,b): return ImageChops.difference(a,b).getbbox() is None
first=frame(0); reference=Image.open(root/'reference.png').convert('RGB')
mask=Image.open(root/'mask.png').convert('L').point(lambda v:255 if v>100 else 0).filter(ImageFilter.MaxFilter(5))
outside=ImageChops.invert(mask)
end=data['total']; empty_start=end-60
overflow=[]; empty=[]
for i in range(end+1):
 current=frame(i)
 diff=ImageChops.difference(first,current)
 if any(ImageChops.multiply(c,outside).getbbox() for c in diff.split()): overflow.append(i)
 if i>=empty_start and not same(first,current): empty.append(i)
report={'name':data['name'],'referenceMatchesFirstFrame':same(reference,first),'referencePSNR':'inf' if same(reference,first) else 'different','seamExact':same(first,frame(end)),'restExact':same(first,frame(end-1)),'emptyFramesChecked':61,'emptyFailures':empty,'overflowFramesChecked':end+1,'overflowFailures':overflow,'errors':data['errors'],'adaptations':data['adaptations']}
indices=[r['frame'] for r in data['frameRecords']]
sheet=Image.new('RGB',(1600,280*((len(indices)+3)//4)),'#fafbf8');draw=ImageDraw.Draw(sheet)
for n,i in enumerate(indices):
 x,y=(n%4)*400,(n//4)*280
 img=frame(i);img.thumbnail((400,250),Image.Resampling.LANCZOS);sheet.paste(img,(x,y))
 draw.text((x+10,y+258),f'{i/60:.2f}s',fill='#263b1e')
sheet.save(root/'contact-sheet.jpg',quality=94)
(root/'verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(report,ensure_ascii=False))
assert report['referenceMatchesFirstFrame'], 'Reference rendering changed'
assert report['seamExact'] and report['restExact'], 'Loop did not return to the original state'
assert not overflow and not empty and not data['errors'], 'Capture verification failed'
