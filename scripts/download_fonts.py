"""Vendor openly licensed Google Fonts so the simulator needs no runtime CDN."""
from pathlib import Path
import re
import urllib.request

root = Path(__file__).resolve().parents[1]
target = root / 'public' / 'fonts'
target.mkdir(parents=True, exist_ok=True)
css_url = 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Playfair+Display:ital,wght@0,500;0,600;1,500&display=swap'
with urllib.request.urlopen(css_url, timeout=30) as response:
    css = response.read().decode('utf-8')
names = ['dm-sans-400', 'dm-sans-500', 'dm-sans-600', 'dm-sans-700', 'playfair-italic-500', 'playfair-500', 'playfair-600']
for name, url in zip(names, re.findall(r'url\((https:[^)]+)\)', css)):
    with urllib.request.urlopen(url, timeout=30) as response:
        (target / (name + '.ttf')).write_bytes(response.read())
    css = css.replace(url, './' + name + '.ttf')
for family, directory in [('DM-Sans', 'dmsans'), ('Playfair-Display', 'playfairdisplay')]:
    url = 'https://raw.githubusercontent.com/google/fonts/main/ofl/' + directory + '/OFL.txt'
    with urllib.request.urlopen(url, timeout=30) as response:
        (target / (family + '-OFL.txt')).write_bytes(response.read())
(target / 'fonts.css').write_text(css)
print('Vendored 7 font files and 2 OFL licences.')
