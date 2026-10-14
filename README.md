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
npm run audit:streets -- --check
npm run build
npm run preview
```

`npm test` kontroluje také vykreslovanou geometrii celé trati: konečné souřadnice GPU, návaznost povrchů, průniky terénu s vozovkou a chodníky, podélný i příčný sklon kolejnic a výšku středu jízdního profilu. Obě koleje v obou směrech se kontrolují po jednom metru. Povrchy se ořezávají přesně u fasád a mapovaných hranic; plochy v rozdílných výškách se nepřekrývají pouze podle půdorysu. Základy a přízemní detaily budov navazují na místní sklon terénu.

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

- 20,99 km oficiální kilometráže PID GTFS a 44 směrových zastávek. Jízdní osa sleduje jednotlivé směrové koleje OSM se zachovanými vrcholy a průjezdy výhybkami; protisměr má vlastní mapované vedení včetně splítky.
- 5 277 půdorysů budov z OSM, okolní ulice, odbočné koleje, parky, stromy a Vltava s ostrovy.
- Dalších 8 181 skutečných okolních budov v dostupných mapových výřezech do 750 m od trasy a 1 477 ploch využití území. Hustší pozadí zachovává městské bloky; mapované zahrady a parky zůstávají zelené.
- 371 mapovaných ploch náměstí a veřejných prostranství s 74 vnitřními otvory, 4 677 pěších cest v datech a 1 332 uzlů městského mobiliáře. Detailní pěší cesty se vykreslují poblíž tratě; lavice, koše a sloupky respektují původní mapové polohy a průjezdnost.
- Výškový profil a 3 686 vzorků okolního terénu z Copernicus DEM: kopce mají vlastní výšky, okolí kolejí plynule navazuje na jízdní profil.
- Souprava T3R.P s kabinou, podvozky, pantografy, světly a samostatně animovanými dveřmi.
- Podrobná kabina podle fotografických referencí, animovaný rychloměr, dveřní křídla, interiér a kontaktní lišta pantografu.
- Tři modely automobilů se zaoblenými karoseriemi, interiérem a detailními koly; čtyři varianty chodců s přirozenějšími proporcemi, oblečením a kloubovou animací. Modely vznikají v Blenderu. Lampy, přístřešky a modely sv. Mikuláše a Národního divadla.
- Fotografické PBR mapy dlažby, asfaltu, chodníků, omítky, střech a zeleně; HDR obloha a odrazy, stíny a kontaktní zastínění GTAO. Fotogrammetrický strom CC0 optimalizovaný v Blenderu.
- Trojrozměrné rámy oken, římsy, parapety, svody, dveře, výlohy a balkony na skutečných půdorysech. Nástupiště sledují oblouk a sklon trati; průjezd Oettingenským palácem má otvor a kolejovou splítku. Na střechách jsou komíny a vikýře.
- Fasády sdílejí skutečná podlaží, dostupné barvy a architektonické tagy OSM. Valbové, sedlové, mansardové a jehlanové střechy sledují natočení půdorysu; vnitřní dvory mají otevřené střechy a vlastní stěny. Volná místa se nezastavují náhodnými domy.
- Okna mají otevřená ostění, odrazy skutečné oblohy a pohledově závislou hloubku interiéru. Nátěry rámů a dveří jsou sjednocené po domech, portály mají prahy a sokly stopy vlhkosti. Generované názvy obchodů byly odstraněny.
- Domy s mapovanou adresou mají domovní tabulku s přesným zdrojovým textem. Kostel sv. Ludmily na náměstí Míru používá šest skutečných stavebních objemů včetně obou 60m věží; jejich samostatné půdorysy již nenahrazuje obyčejný blok.
- Střechy respektují dostupnou výšku, orientaci hřebene, směr spádu a sklon. Výška OSM již nezvyšuje budovu o další střechu; skutečné vysoké domy nejsou oříznuté na 65 m. Obloha, odrazy i sluneční stíny sdílejí stejné světlo, déšť a podvečer mají vlastní atmosférické odrazy.
- Půdorysy vozovek, chodníků, parkovacích ploch a oddělených tramvajových těles vycházejí v dostupném koridoru z aktuálně publikovaných polygonů DTM Prahy (stav 30. září 2026 a změny do 13. října 2026). U doložených ploch se uchovávají původní hranice, otvory, výšky a třídy přesnosti; zatravněná kolejová tělesa zůstávají zelení. OSM doplňuje plnou geometrii, směry jízdy, přístup, pruhy a povrchy. Motorové pruhy sledují samostatné silnice; ulice se společným provozem jsou odlišeny od vyhrazené tratě. Obruby sledují skutečné hranice ploch a vjezdy zůstávají otevřené. Historické chodníky mají původní generovanou mozaiku s kameny 6 × 6 cm; stromy respektují vozovky, vodu a fasády.
- Dlažba a asfalt hlavní ulice přebírají dostupné povrchové tagy souběžných komunikací po délce i šířce vozovky. Příčná odbočka nepřemaluje celý úsek a neznámý povrch zůstává přiznaným odhadem.
- Silueta katedrály sv. Víta vychází ze 133 mapovaných částí budovy OSM, včetně skutečné orientace, dvou západních věží a jižní věže s barokní helmou.
- Sílová jízdní fyzika v SI jednotkách: výkon a hmotnost, jízdní odpory, svahy, omezení změny zrychlení, adheze, prokluz/protismyk, ruční pískování, rekuperace a přechod elektrické brzdy na mechanickou. Nouzová kolejnicová brzda, klopení a jemné vibrace podvozku.
- 495 skutečných přechodových uzlů OSM, synchronizované tramvajové, automobilové a pěší signály. Fronty aut, křižující provoz, protijedoucí soupravy, parkování a reakce na chodce, dveře a zvonek. Kolize používají orientované půdorysy a změnu hybnosti.
- Chodci chodí po chodnících, čekají na přechodu a docházejí ke skutečným dveřím. Obsluha zastávek, hodnocení a uložení služby.
- Jasno, déšť a podvečer; nepravidelně mokré povrchy, pohyb vodní hladiny, dešťové pruhy a kapky na skutečných čelních sklech, které stírají animované stěrače. V ulicích jsou obrubníky, kanalizační vpusti, poklopy a listí u shluků mapovaných stromů.
- Lokální změny adheze, postupné smáčení a schnutí kolejí, tepelná bilance mechanických brzd a brzdových odporníků, pohupování a hodnocení pohodlí cestujících. Panel ukazuje odhad brzdné dráhy, teplotu brzd a pohodlí jízdy.
- Řidiči mají různé odstupy a reakce při rozjezdu fronty; za deště jedou opatrněji. Chodci vyhodnocují příjezd vozidel a signály počítají s dobou vyklizení skutečné šířky přechodu.
- Syntetický zvuk, minimapa, celá mapa a tři úrovně kvality.

## Míra věrnosti a zdroje

Jde o funkční simulátor se skutečnými geografickými podklady a autorskou rekonstrukcí okolí. Půdorysy ulic používají veřejné balíčky DTM Prahy ke stavu 30. září 2026, doplněné všemi publikovanými denními změnami do 13. října 2026; balíček za 14. října ještě nebyl zveřejněný. Datum balíčku není datem zaměření každého objektu. Původní úrovně, výšky a třídy přesnosti se zachovávají; neznámé nebo chybné výšky se nepovažují za důvěryhodné zaměření. Není to fotogrammetrická kopie Prahy ani certifikovaný výcvikový simulátor. Fasády, část střech, detaily dominant, neznámé výšky, rozložení trolejí, návěstní cykly, rychlostní omezení a provoz jsou herní aproximace. Terénní model v rozlišení 90 m nenahrazuje přesné zaměření kolejí. Aktuální krátkodobé výluky, protisměrná varianta linky a vozovnové nájezdy nejsou zahrnuté.

[Audit ulic celé linky](docs/street-layout-audit.json) kontroluje 43 mezizastávkových úseků podle skutečně načítané směrové koleje. Výpis rozlišuje motorové plochy, skutečná zatravněná tělesa, relativní úrovně zdrojů a nejisté výšky. Kontrola `--check` hlídá geometrii pruhů, přístup, návaznost silnic, zdrojové obrysy a úrovňové pěší přechody. Publikované půdorysy ani jejich uložené desetinné číslice nejsou zárukou centimetrové přesnosti nebo úplného zaměření každé části linky.

Podrobný původ dat, licence a ověřené zdroje jsou v [docs/research.md](docs/research.md). Reprodukce aktuální DTM vyžaduje vlastní Python 3.11+, pyproj 3.8.0, Shapely 2 a PROJ 9.4+ pro oficiální korekční mřížku; přesné příkazy jsou v tomto dokumentu. Parametry a fyzikální aproximace v [docs/physics.md](docs/physics.md), městský provoz v [docs/traffic.md](docs/traffic.md).

Hlavní primární zdroje: [PID GTFS](https://pid.cz/o-systemu/opendata/), [DPP Tatra T3R.P](https://www.dpp.cz/vozovy-park/tramvaje/tatra-t3r-p), [OpenStreetMap](https://www.openstreetmap.org/copyright), [Open-Meteo / Copernicus DEM](https://open-meteo.com/en/docs/elevation-api).

PID a výšková data: CC BY 4.0. Geografická databáze OSM: © přispěvatelé OpenStreetMap, ODbL 1.0. Půdorysy povrchů: datový podklad © IPR Praha, CC BY 4.0, vybraný koridor a převod souřadnic; původ a atributy jednotlivých objektů jsou uchovány v `public/data/street-surfaces.json`; původní S-JTSK souřadnice a 3D hranice v bezeztrátovém `public/data/street-surfaces-source.json.gz`, propojeném kontrolními součty. [Manifest balíčků](docs/dtm-package-manifest.json) uchovává přímé zdrojové URL, data a SHA-256. Samostatné geodetické osy jednotlivých kolejí z veřejné DI uchovávají skutečné vlastníky/editory a bezeztrátový zdroj; [veřejný výdej DMVS](https://www.cuzk.gov.cz/DMVS/Poskytovani-dat.aspx) je ověřený, výslovná DI licence v balíčcích identifikovaná nebyla a CC BY se na ně automaticky nepřenáší. Fonty: SIL Open Font License, přiložená v `public/fonts/`. Fotografické materiály, HDR a zdroj stromu: [Poly Haven, CC0](https://polyhaven.com/license), přesný seznam v `public/textures/manifest.json`. Ostatní modely a generátory jsou původní součástí projektu. Referenční fotografie tramvají sloužily pouze k modelování a nejsou redistribuované.

## Blender a struktura projektu

Nativní modely jsou v `assets/*.blend`, exportované GLB v `public/models/`. Reprodukce modelů:

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup --python scripts/create_detailed_assets.py
```

Na jiném systému použijte cestu k instalaci Blenderu. Generátor vytváří nativní soubory, GLB a vlastní náhledy; pro hraní není Blender potřeba. Modelové souřadnice po exportu: Y nahoru, čelo vozidla −Z, původ na úrovni kolejí.

Konkrétní modely lze přegenerovat parametrem `-- --models car hatchback van pedestrian pedestrian_2 pedestrian_3 pedestrian_4`. Ostatní modelové soubory se tím nepřepisují.

Materiály lze znovu stáhnout příkazem `python3 scripts/download_materials.py` (kontroluje MD5 vůči oficiálnímu API). Strom se připraví `python3 scripts/prepare_tree.py` a následně Blenderem `--background --factory-startup --python scripts/prepare_tree.py -- --blender`. Původní `create_assets.py` obsahuje základní modely a sdílené nástroje; pro nové vozy používejte podrobný generátor výše.

Vysoká kvalita používá GTAO, měkké stíny, HDR a větší dohled. Vyvážená kvalita vypíná GTAO a snižuje rozlišení i dohled; úsporná také vykresluje bez postprocessingu. Vzdálená vozidla, lidé, okna a stromy jsou dávkované do instancí; vzdálené rámy oken používají jednodušší geometrii se zachovaným ostěním. Výchozí je vyvážená kvalita a ruční volba se pamatuje v prohlížeči. Výkon závisí na GPU, rozlišení a hustotě okolí.

Data a modely se načítají paralelně v bezeztrátově komprimované podobě. Vite vytváří `.json.gz` a `.glb.gz` při sestavení a obsluhuje je i během vývoje; fungují i na GitHub Pages bez konfigurace komprese serveru. Prohlížeče bez `DecompressionStream` používají původní soubory. Prostorový index trati a cache přesných profilů omezují opakované výpočty při stavbě města a simulaci provozu. Stavba ulic sdílí přesné výškové dotazy a kandidátní hrany zaměřených ploch; cache mají omezenou velikost a nerozostřují souřadnice ani hranice jednotlivých výškových úrovní. Kolejové pásy používají společné stanice a opakované materiálové průchody znovu využívají stejné body. Konvexní povrchy se při ořezávání porovnávají oddělujícími polorovinami, bez opakovaného porovnávání všech dvojic hran.

Statická geometrie okolních ulic se připravuje při sestavení a distribuuje jako verzovaný binární soubor a jeho gzip varianta. Prohlížeč obnoví původní souřadnice, normály a UV bez ztrátové kvantizace a připojí načtené materiály; neopakuje náročné ořezávání ulic při každém otevření hry. První sestavení po změně podkladů proto trvá déle. `npm run prepare:scenery` připraví stejný podklad předem; další sestavení používají ověřenou cache v `.openai/runtime`. Změny zdrojového kódu, geografických dat nebo závislostí cache automaticky zneplatní. Vývojový server podklad připraví při prvním požadavku. Nedostupný nebo neplatný soubor spustí původní procedurální stavbu.

| Soubor                                                                        | Úloha                                                          |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `src/main.js`                                                                 | Rozhraní, ovládání, ukládání a herní smyčka                    |
| `src/simulation.js`                                                           | Nezávislá jízdní fyzika a provoz                               |
| `src/world.js`                                                                | Three.js scéna, trať, tramvaje, kamery a počasí                |
| `src/osm-scenery.js`                                                          | Dávkované komunikace, parky, stromy a vedlejší koleje OSM      |
| `src/facades.js` / `src/roof-details.js` / `src/materials.js`                 | Plastické detaily budov a fyzikální povrchy                    |
| `src/urban-life.js` / `src/urban-lod.js`                                      | Chodci, auta, semafory, kolize a jejich úrovně detailu         |
| `src/route.js`                                                                | Převod geografických souřadnic, vzdálenosti a výškový profil   |
| `src/terrain.js` / `src/street-profile.js` / `src/scenery-spatial.js`         | Okolní terén, souvislé šířky ulic a mapové odstupy             |
| `src/building-profiles.js` / `src/prague-paving.js` / `src/prague-skyline.js` | Typologie budov, mozaika a mapovaná silueta katedrály          |
| `src/audio.js`                                                                | Web Audio a hlášení                                            |
| `src/weather-effects.js` / `src/street-details.js`                            | Mokré povrchy, čelní sklo, voda, detaily ulic a listí u stromů |
| `scripts/create_detailed_assets.py`                                           | Podrobné Blender modelování a export vozidel a lidí            |
| `public/data/*.json`                                                          | Distribuovaná geografická data a jejich původ                  |

Ve vývojářské konzoli je dostupné pouze čtecí `tramDebug.snapshot()` a `tramDebug.stats()` pro diagnostiku, včetně celkového času načítání, jednotlivých fází stavby scény v milisekundách a příznaku `prebuiltScenery` pro ověření obnovených ulic. `npm run profile:startup` měří referenční procedurální přípravu celé trasy a geometrie nad skutečnými daty bez předpočítaných ulic, stahování modelů a vykreslování na GPU.
