import re, os, sys
md=sys.argv[1]; base=os.path.dirname(os.path.abspath(md))
s=open(md).read()
links=re.findall(r'!?\[[^\]]*\]\(([^)\s]+)\)',s)
rel=[l for l in links if not re.match(r'[a-z]+://',l) and not l.startswith('#')]
bad=[l for l in rel if not os.path.isfile(os.path.join(base,l))]
imgs=re.findall(r'!\[[^\]]*\]\(([^)\s]+)\)',s)
media=set()
for r,_,fs in os.walk(os.path.join(base,'media')):
    for f in fs: media.add(os.path.relpath(os.path.join(r,f),base))
unref=sorted(media-set(rel))
print(f"relative links: {len(rel)}, image embeds: {len(imgs)}, broken: {len(bad)}, media files: {len(media)}, unreferenced media: {len(unref)}")
for b in bad: print('BROKEN',b)
for u in unref: print('UNREFERENCED',u)
sys.exit(1 if bad or unref else 0)
