# Praha · Linka 22

Hratelný tramvajový simulátor v JavaScriptu a Three.js. Řídíte soupravu dvou vozů Tatra T3R.P po celé pravidelné trase **Bílá Hora → Nádraží Hostivař**. Lze začít na kterékoli ze 44 zastávek; výchozí náhled ukazuje Malostranské náměstí.

## Spuštění

Potřebujete Node.js 22.12 nebo novější, moderní prohlížeč s WebGL 2 a zapnutou hardwarovou akcelerací.

```sh
npm install
npm run dev
```

Otevřete adresu vypsanou Vite, obvykle http://localhost:5173. HTML se nespouští dvojklikem ze souborového systému. Three.js, modely, geografická data a fonty se po instalaci načítají místně. Hra nepotřebuje API klíče ani živé připojení k mapové službě. Prohlížeč může použít dostupný český systémový hlas pro hlášení zastávek.

```sh
npm test
npm run build
npm run preview
```

`dist/` je samostatný statický web vhodný k hostování. Průběh služby se automaticky ukládá do localStorage daného prohlížeče; obnovení začíná s bezpečně stojícím vozidlem.

## GitHub Pages

Hra se nasazuje na **https://robertlib.github.io/linka-22/** pomocí workflow [Deploy to GitHub Pages](.github/workflows/deploy-pages.yml).

V repozitáři [RobertLib/linka-22](https://github.com/RobertLib/linka-22/settings/pages) nastavte **Settings → Pages → Build and deployment → Source → GitHub Actions**. Po každém pushi do `main` workflow nainstaluje závislosti přes `npm ci`, spustí testy, sestaví hru a publikuje obsah `dist/`. Nasazení lze spustit také ručně přes **Actions → Deploy to GitHub Pages → Run workflow** z větve `main`.

Workflow určí základní cestu z nastavení Pages. Data, modely, textury i fonty se načítají z této cesty, takže fungují i v podadresáři repozitáře. Pro místní ověření stejného sestavení:

```sh
VITE_BASE_PATH=/linka-22/ npm run build
VITE_BASE_PATH=/linka-22/ npm run preview
```

Otevřete http://localhost:4173/linka-22/. Běžné `npm run dev` dál používá kořenovou cestu `/`. Není potřeba větev `gh-pages`, vlastní server ani API klíče.

## Ovládání

| Klávesa                | Funkce                                       |
| ---------------------- | -------------------------------------------- |
| W / S                  | Přidat výkon / přidat brzdu v krocích řadiče |
| X                      | Výběh; po zastavení uvolnění nouzové brzdy   |
| E                      | Pravé dveře celé soupravy                    |
| Mezerník               | Nouzová brzda                                |
| B                      | Zvonek                                       |
| G (podržet)            | Pískování kolejnic pro zvýšení adheze        |
| C                      | Kabina, pohled za tramvají, pohled shora     |
| M                      | Mapa celé linky                              |
| H                      | Nápověda                                     |
| V                      | Stěrače                                      |
| ← / → nebo tažení myší | Rozhlížení z kabiny                          |
| Dvojklik na scénu      | Vrátit pohled dopředu                        |
| Esc                    | Pauza / zavřít dialog                        |
| F                      | Celá obrazovka                               |

Řadič zůstává v nastavené poloze. Na zastávce zastavte čelem u označníku, otevřete pravé dveře, počkejte na dokončení nástupu a zavřete je. Minimální pobyt po otevření je 8 sekund. Otevřené i zavírající se dveře blokují trakci. Návěst ze dvou svislých bílých bodů znamená volno, tři vodorovné body znamenají stůj. Rychlostní limit se mění podle zakřivení trati a herních úseků. Automatické brzdění za řidiče není zapnuté.

## Obsah

- 20,99 km skutečné geometrie oficiálního PID GTFS, 660 bodů a 44 směrových zastávek.
- 5 277 půdorysů budov z OSM, okolní ulice, odbočné koleje, parky, stromy a Vltava s ostrovy.
- Výškový profil odvozený z Copernicus DEM, upravený pro sklony a most.
- Souprava T3R.P s kabinou, podvozky, pantografy, světly a samostatně animovanými dveřmi.
- Podrobná kabina podle fotografických referencí, animovaný rychloměr, dveřní křídla, interiér a kontaktní lišta pantografu.
- Tři modely automobilů a čtyři varianty chodců s kloubovou animací, vytvořené v Blenderu. Lampy, přístřešky a modely sv. Mikuláše a Národního divadla.
- Fotografické PBR mapy dlažby, asfaltu, chodníků, omítky, střech a zeleně; HDR obloha a odrazy, stíny a kontaktní zastínění GTAO. Fotogrammetrický strom CC0 optimalizovaný v Blenderu.
- Trojrozměrné rámy oken, římsy, parapety, svody, dveře, výlohy a balkony na skutečných půdorysech. Nástupiště sledují oblouk a sklon trati; průjezd Oettingenským palácem má otvor a kolejovou splítku. Na střechách jsou komíny a vikýře.
- Sílová jízdní fyzika v SI jednotkách: výkon a hmotnost, jízdní odpory, svahy, omezení změny zrychlení, adheze, prokluz/protismyk, ruční pískování, rekuperace a přechod elektrické brzdy na mechanickou. Nouzová kolejnicová brzda, klopení a jemné vibrace podvozku.
- 495 skutečných přechodových uzlů OSM, synchronizované tramvajové, automobilové a pěší signály. Fronty aut, křižující provoz, protijedoucí soupravy, parkování a reakce na chodce, dveře a zvonek. Kolize používají orientované půdorysy a změnu hybnosti.
- Chodci chodí po chodnících, čekají na přechodu a docházejí ke skutečným dveřím. Obsluha zastávek, hodnocení a uložení služby.
- Jasno, déšť a podvečer, syntetický zvuk, minimapa, celá mapa a tři úrovně kvality.

## Míra věrnosti a zdroje

Jde o funkční simulátor se skutečnými geografickými podklady a autorskou rekonstrukcí okolí. Není to fotogrammetrická kopie Prahy ani certifikovaný výcvikový simulátor. Fasády, část střech, detaily dominant, neznámé výšky, rozložení trolejí a nástupišť, návěstní cykly, rychlostní omezení a provoz jsou herní aproximace. Terénní model v rozlišení 90 m nenahrazuje přesné zaměření kolejí. Aktuální krátkodobé výluky, protisměrná varianta linky a vozovnové nájezdy nejsou zahrnuté.

Podrobný původ dat, licence a ověřené zdroje jsou v [docs/research.md](docs/research.md); parametry a fyzikální aproximace v [docs/physics.md](docs/physics.md), městský provoz v [docs/traffic.md](docs/traffic.md).

Hlavní primární zdroje: [PID GTFS](https://pid.cz/o-systemu/opendata/), [DPP Tatra T3R.P](https://www.dpp.cz/vozovy-park/tramvaje/tatra-t3r-p), [OpenStreetMap](https://www.openstreetmap.org/copyright), [Open-Meteo / Copernicus DEM](https://open-meteo.com/en/docs/elevation-api).

PID a výšková data: CC BY 4.0. Geografická databáze OSM: © přispěvatelé OpenStreetMap, ODbL 1.0. Fonty: SIL Open Font License, přiložená v `public/fonts/`. Fotografické materiály, HDR a zdroj stromu: [Poly Haven, CC0](https://polyhaven.com/license), přesný seznam v `public/textures/manifest.json`. Ostatní modely a generátory jsou původní součástí projektu. Referenční fotografie tramvají sloužily pouze k modelování a nejsou redistribuované.

## Blender a struktura projektu

Nativní modely jsou v `assets/*.blend`, exportované GLB v `public/models/`. Reprodukce modelů:

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup --python scripts/create_detailed_assets.py
```

Na jiném systému použijte cestu k instalaci Blenderu. Generátor vytváří nativní soubory, GLB a vlastní náhledy; pro hraní není Blender potřeba. Modelové souřadnice po exportu: Y nahoru, čelo vozidla −Z, původ na úrovni kolejí.

Materiály lze znovu stáhnout příkazem `python3 scripts/download_materials.py` (kontroluje MD5 vůči oficiálnímu API). Strom se připraví `python3 scripts/prepare_tree.py` a následně Blenderem `--background --factory-startup --python scripts/prepare_tree.py -- --blender`. Původní `create_assets.py` obsahuje základní modely a sdílené nástroje; pro nové vozy používejte podrobný generátor výše.

Vysoká kvalita používá GTAO, měkké stíny, HDR a větší dohled. Vyvážená kvalita vypíná GTAO a snižuje rozlišení i dohled; úsporná také vykresluje bez postprocessingu. Vzdálená vozidla, lidé, okna a stromy jsou dávkované do instancí. Výkon závisí na GPU, rozlišení a hustotě okolí; hra má tři ručně přepínané režimy, neskrývá automaticky detaily.

| Soubor                                                        | Úloha                                                        |
| ------------------------------------------------------------- | ------------------------------------------------------------ |
| `src/main.js`                                                 | Rozhraní, ovládání, ukládání a herní smyčka                  |
| `src/simulation.js`                                           | Nezávislá jízdní fyzika a provoz                             |
| `src/world.js`                                                | Three.js scéna, trať, tramvaje, kamery a počasí              |
| `src/osm-scenery.js`                                          | Dávkované komunikace, parky, stromy a vedlejší koleje OSM    |
| `src/facades.js` / `src/roof-details.js` / `src/materials.js` | Plastické detaily budov a fyzikální povrchy                  |
| `src/urban-life.js` / `src/urban-lod.js`                      | Chodci, auta, semafory, kolize a jejich úrovně detailu       |
| `src/route.js`                                                | Převod geografických souřadnic, vzdálenosti a výškový profil |
| `src/audio.js`                                                | Web Audio a hlášení                                          |
| `scripts/create_detailed_assets.py`                           | Podrobné Blender modelování a export vozidel a lidí          |
| `public/data/*.json`                                          | Distribuovaná geografická data a jejich původ                |

Ve vývojářské konzoli je dostupné pouze čtecí `tramDebug.snapshot()` a `tramDebug.stats()` pro diagnostiku.
