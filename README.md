# Praha · Linka 22

Hratelný tramvajový simulátor v JavaScriptu a Three.js. Řídíte soupravu dvou vozů Tatra T3R.P po celé pravidelné trase **Bílá Hora → Nádraží Hostivař** podle skutečného jízdního řádu PID. Lze začít na kterékoli ze 44 zastávek a vybrat den a publikovaný spoj; výchozí je nejbližší skutečný odjezd z Malostranského náměstí podle pražského času. Slunce, obloha, stíny i noční osvětlení odpovídají zvolenému dni a hodině.

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
| R                      | Vystoupit / nastoupit u otevřených dveří     |
| W / A / S / D (venku)  | Pěší pohyb                                   |
| Shift (venku)          | Rychlejší chůze                              |
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

Řadič zůstává v nastavené poloze. Na zastávce zastavte čelem u označníku, otevřete pravé dveře, počkejte na dokončení výstupu a nástupu a zavřete je. Pobyt závisí na počtu cestujících, nejméně 8 sekund. Otevřené i zavírající se dveře blokují trakci. Odjíždějte podle jízdního řádu: panel ukazuje čas odjezdu a odchylku, předčasný odjezd je chyba, zpoždění do tří minut se toleruje. Říčanova a Dubečská jsou zastávky na znamení; zastavit musíte, jen když svítí znamení k zastavení. Návěst ze dvou svislých bílých bodů znamená volno, tři vodorovné body znamenají stůj. Rychlostní omezení vychází z mapovaných limitů tramvajových drah a vozovek a ze zakřivení trati; platí, dokud jím neprojede i zadní vůz, a panel předem hlásí další nižší limit. Automatické brzdění za řidiče není zapnuté.

Po úplném zastavení otevřete dveře klávesou **E**, počkejte na jejich otevření a stiskněte **R** pro vystoupení. Venku se pohybujete pomocí **WASD**; **Shift** zrychlí chůzi. Tažením myši nebo šipkami se rozhlížíte kolem sebe. Pohyb respektuje zem, budovy, tramvaj a vodní plochy. U kterýchkoli otevřených dveří soupravy stiskněte znovu **R** a vrátíte se do kabiny. Během procházky tramvaj zůstává zabrzděná a ovládání jízdy je vypnuté. Po obnovení uložené služby začínáte v kabině.

## Obsah

- Skutečný jízdní řád PID GTFS platný 18.–31. října 2026: 165 spojů se stejnou posloupností zastávek (73 z Bílé Hory, 92 z Vypichu), kalendáře včetně svátku 28. října a zastávky na znamení. Hodnotí se včasnost odjezdů, hlásí se přestupy na metro, lanovou dráhu a vlaky.
- Rychlostní omezení po celé trati z OSM: 60 km/h v Chotkově ulici, 30 km/h ve vozovce Letenské, 15 km/h na výhybkách, jinak 50 km/h; k tomu omezení oblouků a splítky.
- Poloha slunce podle algoritmu NOAA pro skutečné datum a pražský čas. Sedm fotografických obloh se volí podle výšky slunce a natáčí na jeho azimut; po setmění svítí lampy, okna, výlohy, světla aut i tramvaje.
- Barvy domů bez mapované barvy podle charakteru čtvrtí, od barokních pastelů Malé Strany po barevně zateplené paneláky Hostivaře. Pálené střechy v centru. Fotografické textury jsou normalizované, aby nezkreslovaly skutečné barvy.
- Počet čekajících, nastupujících a vystupujících cestujících podle zastávky a denní doby; stejní lidé čekají na nástupišti.
- 20,99 km oficiální kilometráže PID GTFS a 44 směrových zastávek. Jízdní osa sleduje jednotlivé směrové koleje OSM se zachovanými vrcholy a průjezdy výhybkami; protisměr má vlastní mapované vedení včetně splítky.
- 5 277 půdorysů budov z OSM, okolní ulice, odbočné koleje, parky, stromy a Vltava s ostrovy.
- Dalších 8 181 skutečných okolních budov v dostupných mapových výřezech do 750 m od trasy a 1 477 ploch využití území. Hustší pozadí zachovává městské bloky; mapované zahrady a parky zůstávají zelené.
- 371 mapovaných ploch náměstí a veřejných prostranství s 74 vnitřními otvory, 4 677 pěších cest v datech a 1 332 uzlů městského mobiliáře. Detailní pěší cesty se vykreslují poblíž tratě; lavice, koše a sloupky respektují původní mapové polohy a průjezdnost.
- Lidarový model terénu IPR Praha (holý terén, zhruba 40 bodů/m²) převzorkovaný na 1,48 milionu výšek: 4 m u trati, 8 m do 650 m a 20 m v pozadí celého vykreslovaného obdélníku. Terénní síť se adaptivně zjemňuje až na 5 m tam, kde jsou náspy, zářezy, svahy a zahrady; navazující buňky nemají trhliny. Výškový profil trati vychází ze stejného lidaru po 2 m (most Legií je přemostěný), nejprudší úsek Keplerovou ulicí má 8,6 %. Hladina Vltavy, rybníky, parky a náměstí sledují změřený terén.
- Fotogrammetrický 3D model budov IPR Praha pro 7 861 budov OSM do 320 m od trati: skutečná výška terénu, okapu a hřebene, střechy včetně komínů, vikýřů, věží a světlíků (320 tisíc trojúhelníků). Stěny zůstávají na půdorysu OSM kvůli fasádám, ale jejich horní hrana sleduje změřenou okapovou linii, štíty a výškové skoky. Budovy postavené po snímkování si ponechávají odhad.
- 103 fotogrammetrických mostů IPR v dohledu trati: oblouky a pilíře mostu Legií, Karlův most i železniční most nad tratí u Zahradního Města.
- Zaměřené prvky z úplné technické mapy DTM Prahy (kresba ZPS): 2 557 zdí včetně 1 707 opěrných, 4 400 plotů podle druhu (kovové, drátěné, dřevěné, zděné, živé), 881 zábradlí, svodidla, protihlukové stěny, kašny, fontány, pomníky, sochy, kříže, studny, informační tabule a reklamní sloupy. Opěrné zdi drží skutečný terénní stupeň mezi lidarovým terénem na obou stranách. Zaměřené sloupy u trati nesou příčná trolejová lana; syntetické stožáry doplňují jen mezery.
- Digitální model povrchu IPR z roku 2025 doplňuje aktuální stav: 501 budov má střechu změřenou v roce 2025 (110 z nich proto, že se střecha od 3D modelu změnila), stromy mají změřenou výšku a šířku koruny a 15 841 dalších stromů ze zahrad, dvorů a lesů je detekováno z korun ověřených infračerveným ortofotem. Volně stojící zdi, živé ploty a sochy mají změřenou výšku. Střechy 8 217 budov mají skutečnou barvu z ortofota 2024.
- Most Legií stoupá jako ve skutečnosti od Újezdu o 3 m ke Střeleckému ostrovu; dvě ploché části modelu nad malostranským ramenem doplňují klenby odvozené z měřených kleneb mostu. Zaměřené chodníky mostovky leží na měřeném profilu mostu a lemuje je pískovcová balustráda s kuželkami a pilíři. 556 pouličních lamp a 76 trakčních stožárů z OSM stojí na skutečných místech. Typ svítidla odpovídá úsekům podle pouličních fotografií: historické lucerny na Klárově, v Letenské, na Malostranském náměstí, mostě Legií a u Národního divadla, svítidla zavěšená na příčných lanech nad Karmelitskou, Újezdem, Národní, Spálenou, Ječnou a I. P. Pavlovou, jinde pozinkované stožáry s výložníkem.
- 11 529 jednotlivých stromů ze sdílených dat o zeleni IPR (jehličnany mají vlastní siluetu smrku s převislými přesleny, listnaté stromy fotogrammetrický model) a deterministicky osázené lesy a skupiny stromů z DTM, například Obora Hvězda a svahy Petřína.
- Souprava T3R.P s kabinou, podvozky, pantografy, světly a samostatně animovanými dveřmi.
- Podrobná kabina podle fotografických referencí, animovaný rychloměr, dveřní křídla, interiér a kontaktní lišta pantografu.
- Tři modely automobilů se zaoblenými karoseriemi, interiérem a detailními koly; čtyři varianty chodců s přirozenějšími proporcemi, oblečením a kloubovou animací. Modely vznikají v Blenderu. Lampy, přístřešky a modely sv. Mikuláše a Národního divadla.
- Fotografické PBR mapy dlažby, asfaltu, šedé betonové dlažby chodníků, štěrku kolejového lože, omítky, střech a trávníku; HDR obloha a odrazy, stíny a kontaktní zastínění GTAO. Fotogrammetrický strom CC0 optimalizovaný v Blenderu.
- Trojrozměrné rámy oken, římsy, parapety, svody, dveře, výlohy a balkony na skutečných půdorysech. Nástupiště sledují oblouk a sklon trati; průjezd Oettingenským palácem má otvor a kolejovou splítku. Na střechách jsou komíny a vikýře.
- Fasády sdílejí skutečná podlaží, dostupné barvy a architektonické tagy OSM. Valbové, sedlové, mansardové a jehlanové střechy sledují natočení půdorysu; vnitřní dvory mají otevřené střechy a vlastní stěny. Volná místa se nezastavují náhodnými domy.
- Okna mají otevřená ostění, odrazy skutečné oblohy a pohledově závislou hloubku interiéru. Nátěry rámů a dveří jsou sjednocené po domech, portály mají prahy a sokly stopy vlhkosti. Generované názvy obchodů byly odstraněny.
- Domy s mapovanou adresou mají domovní tabulku s přesným zdrojovým textem. Kostel sv. Ludmily na náměstí Míru používá šest skutečných stavebních objemů včetně obou 60m věží; jejich samostatné půdorysy již nenahrazuje obyčejný blok.
- Střechy respektují dostupnou výšku, orientaci hřebene, směr spádu a sklon. Výška OSM již nezvyšuje budovu o další střechu; skutečné vysoké domy nejsou oříznuté na 65 m. Obloha, odrazy i sluneční stíny sdílejí stejné světlo, déšť a podvečer mají vlastní atmosférické odrazy.
- Půdorysy vozovek, chodníků, parkovacích ploch a oddělených tramvajových těles vycházejí v dostupném koridoru z aktuálně publikovaných polygonů DTM Prahy (stav 30. září 2026 a změny do 13. října 2026). U doložených ploch se uchovávají původní hranice, otvory, výšky a třídy přesnosti; zatravněná kolejová tělesa zůstávají zelení. OSM doplňuje plnou geometrii, směry jízdy, přístup, pruhy a povrchy. Motorové pruhy sledují samostatné silnice; ulice se společným provozem jsou odlišeny od vyhrazené tratě. Obruby sledují skutečné hranice ploch a vjezdy zůstávají otevřené. Chodníky přebírají povrch sousedních chodníků OSM: mozaiku (`sett`), asfalt nebo šedou betonovou dlažbu; nemapované historické chodníky mají původní generovanou mozaiku s kameny 6 × 6 cm. Stromy respektují vozovky, vodu a fasády.
- Kolejové lože je změřené po 2 m na zaměřených osách kolejí z ortofota IPR (2024) a infračerveného snímku: zatravněná tělesa (Bělohorská, Keplerova, Mariánské hradby, Vršovická), štěrk s pražci (Malý Břevnov, Bělohorská u Vypichu, Švehlova) a koleje v dlažbě či asfaltu. Vzorky pod korunami stromů se doplňují ze sousedních úseků, mostovky se neměří.
- Vodorovné dopravní značení hlavních ulic: podélné čáry pruhů, středová čára a cyklopruhy podle OSM `lanes`, `lanes:forward/backward`, `oneway` a `cycleway:*` v rozměrech TP 133 (čára 0,125 m, úseky 3 m a mezery 6 m). Čáry se přerušují v křižovatkách a na přechodech a nevedou po kolejích ani přes dlažbu.
- Okolní světlo z fotografované oblohy je vyvážené na bílou a pod obzorem i nízko nad ním nahrazené teplým odrazem dlažby a protějších fasád; stíněné fasády si tak drží svou barvu místo modrošedého nádechu.
- Dlažba a asfalt hlavní ulice přebírají dostupné povrchové tagy souběžných komunikací po délce i šířce vozovky. Příčná odbočka nepřemaluje celý úsek a neznámý povrch zůstává přiznaným odhadem.
- Silueta katedrály sv. Víta vychází ze 133 mapovaných částí budovy OSM, včetně skutečné orientace, dvou západních věží a jižní věže s barokní helmou.
- Sílová jízdní fyzika v SI jednotkách: výkon a hmotnost, jízdní odpory, svahy, omezení změny zrychlení, adheze, prokluz/protismyk, ruční pískování, rekuperace a přechod elektrické brzdy na mechanickou. Nouzová kolejnicová brzda, klopení a jemné vibrace podvozku.
- 495 skutečných přechodových uzlů OSM, synchronizované tramvajové, automobilové a pěší signály. Fronty aut, křižující provoz, protijedoucí soupravy, parkování a reakce na chodce, dveře a zvonek. Kolize používají orientované půdorysy a změnu hybnosti.
- Chodci chodí po chodnících, čekají na přechodu a docházejí ke skutečným dveřím. Obsluha zastávek, hodnocení a uložení služby.
- Jasno a déšť v kterékoli denní době; nepravidelně mokré povrchy, pohyb vodní hladiny, dešťové pruhy a kapky na skutečných čelních sklech, které stírají animované stěrače. V ulicích jsou obrubníky, kanalizační vpusti, poklopy a listí u shluků mapovaných stromů.
- Lokální změny adheze, postupné smáčení a schnutí kolejí, tepelná bilance mechanických brzd a brzdových odporníků, pohupování a hodnocení pohodlí cestujících. Panel ukazuje odhad brzdné dráhy, teplotu brzd a pohodlí jízdy.
- Řidiči mají různé odstupy a reakce při rozjezdu fronty; za deště jedou opatrněji. Chodci vyhodnocují příjezd vozidel a signály počítají s dobou vyklizení skutečné šířky přechodu.
- Syntetický zvuk, minimapa, celá mapa a tři úrovně kvality.

## Míra věrnosti a zdroje

Jde o funkční simulátor se skutečnými geografickými podklady a autorskou rekonstrukcí okolí. Půdorysy ulic používají veřejné balíčky DTM Prahy ke stavu 30. září 2026, doplněné všemi publikovanými denními změnami do 13. října 2026; balíček za 14. října ještě nebyl zveřejněný. Datum balíčku není datem zaměření každého objektu. Původní úrovně, výšky a třídy přesnosti se zachovávají; neznámé nebo chybné výšky se nepovažují za důvěryhodné zaměření. Není to fotogrammetrická kopie Prahy ani certifikovaný výcvikový simulátor. Fasády, barvy domů bez mapované barvy, část střech, detaily dominant, neznámé výšky, rozložení trolejí, návěstní cykly a provoz jsou herní aproximace. Rychlostní omezení přebírají komunitní data OSM, nikoli rychlostníky a předpisy DPP. Obsazenost spojů je odhad, PID ji nezveřejňuje. Jízdní řád platí jen v období staženého feedu. Lidarový terén je převzorkovaný na 4–20 m mřížku a nezachytí obrubníky. Vodorovné značení je odvozené z pruhů OSM, ne zaměřené; typy svítidel jsou určené po úsecích podle pouličních fotografií, Praha soupis svítidel nezveřejňuje. Klasifikace kolejového lože vychází z červnového snímku 2024, kdy byla část trávníků suchá; rozhraní typů se může lišit o několik metrů. Prostředí bylo porovnáno se 72 geotagovanými pouličními snímky KartaView (CC BY-SA 4.0) a fotografiemi Wikimedia Commons podél celé trati; snímky slouží jen ke kontrole a nešíří se. 3D model budov vznikal v letech 2001–2008 s aktualizacemi do roku 2020; změny do roku 2025 doplňuje povrchový model, stavby novější zůstávají odhadem. Okna, barvy fasád bez mapované barvy, druhy dřevin a tvary soch nejsou v otevřených datech a jsou aproximací. Aktuální krátkodobé výluky, protisměrná varianta linky a vozovnové nájezdy nejsou zahrnuté.

[Audit ulic celé linky](docs/street-layout-audit.json) kontroluje 43 mezizastávkových úseků podle skutečně načítané směrové koleje. Výpis rozlišuje motorové plochy, skutečná zatravněná tělesa, relativní úrovně zdrojů a nejisté výšky. Kontrola `--check` hlídá geometrii pruhů, přístup, návaznost silnic, zdrojové obrysy a úrovňové pěší přechody. Publikované půdorysy ani jejich uložené desetinné číslice nejsou zárukou centimetrové přesnosti nebo úplného zaměření každé části linky.

Podrobný původ dat, licence a ověřené zdroje jsou v [docs/research.md](docs/research.md). Reprodukce aktuální DTM vyžaduje vlastní Python 3.11+, pyproj 3.8.0, Shapely 2 a PROJ 9.4+ pro oficiální korekční mřížku; přesné příkazy jsou v tomto dokumentu. Parametry a fyzikální aproximace v [docs/physics.md](docs/physics.md), městský provoz v [docs/traffic.md](docs/traffic.md).

Hlavní primární zdroje: [PID GTFS](https://pid.cz/o-systemu/opendata/) (trasa i jízdní řád), [NOAA Solar Calculator](https://gml.noaa.gov/grad/solcalc/calcdetails.html), [DPP Tatra T3R.P](https://www.dpp.cz/vozovy-park/tramvaje/tatra-t3r-p), [OpenStreetMap](https://www.openstreetmap.org/copyright), [otevřená data IPR Praha](https://geoportalpraha.cz/cs/data-a-sluzby/otevrena-data) (3D model budov a mostů, lidarový model terénu, sdílená data o zeleni), [DTM Prahy](https://dmvs.cuzk.gov.cz/portal/vydej-dat/verejne-datove-sady) a pro vzdálené pozadí [Open-Meteo / Copernicus DEM](https://open-meteo.com/en/docs/elevation-api).

PID a výšková data: CC BY 4.0. 3D model budov a mostů, lidarový terén, data o zeleni a technická mapa: datový podklad © IPR Praha, CC BY 4.0; manifesty stažených listů a balíčků s SHA-256 jsou v `docs/ipr-3d-manifest.json`, `docs/ipr-greenery-manifest.json`, `docs/dtm-drawing-package-manifest.json` a `docs/dtm-woodland-package-manifest.json`. Geografická databáze OSM: © přispěvatelé OpenStreetMap, ODbL 1.0. Půdorysy povrchů: datový podklad © IPR Praha, CC BY 4.0, vybraný koridor a převod souřadnic; původ a atributy jednotlivých objektů jsou uchovány v `public/data/street-surfaces.json`; původní S-JTSK souřadnice a 3D hranice v bezeztrátovém `public/data/street-surfaces-source.json.gz`, propojeném kontrolními součty. [Manifest balíčků](docs/dtm-package-manifest.json) uchovává přímé zdrojové URL, data a SHA-256. Samostatné geodetické osy jednotlivých kolejí z veřejné DI uchovávají skutečné vlastníky/editory a bezeztrátový zdroj; [veřejný výdej DMVS](https://www.cuzk.gov.cz/DMVS/Poskytovani-dat.aspx) je ověřený, výslovná DI licence v balíčcích identifikovaná nebyla a CC BY se na ně automaticky nepřenáší. Fonty: SIL Open Font License, přiložená v `public/fonts/`. Fotografické materiály, HDR a zdroj stromu: [Poly Haven, CC0](https://polyhaven.com/license), přesný seznam v `public/textures/manifest.json`. Ostatní modely a generátory jsou původní součástí projektu. Referenční fotografie tramvají sloužily pouze k modelování a nejsou redistribuované.

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
| `src/timetable.js` / `src/passengers.js`                                      | Jízdní řád PID, pražský čas a toky cestujících                 |
| `src/solar.js` / `src/environment.js`                                         | Poloha slunce, volba oblohy a světla podle denní doby          |
| `scripts/import-timetable.py` / `scripts/build-speed-limits.mjs`              | Import jízdního řádu z GTFS a rychlostí z OSM                  |
| `src/terrain.js` / `src/street-profile.js` / `src/scenery-spatial.js`         | Okolní terén, souvislé šířky ulic a mapové odstupy             |
| `src/lidar-terrain.js` / `src/terrain-geometry.js`                            | Lidarová výšková mřížka a adaptivní terénní síť bez trhlin     |
| `src/measured-buildings.js` / `src/measured-bridges.js`                       | Fotogrammetrické střechy, okapové profily stěn a mosty IPR     |
| `src/street-features.js` / `src/ipr-trees.js`                                 | Zdi, ploty, zábradlí a drobné stavby z DTM; stromy a lesy      |
| `src/track-beds.js` / `scripts/import-track-beds.py`                          | Změřené kolejové lože (tráva, štěrk, dlažba) z ortofota IPR    |
| `src/road-markings.js` / `src/sidewalk-surfaces.js`                           | Vodorovné značení z pruhů OSM a povrch chodníků                |
| `src/street-lamps.js` / `src/bridge-balustrade.js`                            | Typy svítidel po úsecích a balustráda mostu Legií              |
| `scripts/import-ipr-*.py` / `scripts/import-dtm-*.py`                         | Reprodukovatelný import dat IPR a DTM s kontrolními součty     |
| `src/building-profiles.js` / `src/prague-paving.js` / `src/prague-skyline.js` | Typologie budov, mozaika a mapovaná silueta katedrály          |
| `src/audio.js`                                                                | Web Audio a hlášení                                            |
| `src/weather-effects.js` / `src/street-details.js`                            | Mokré povrchy, čelní sklo, voda, detaily ulic a listí u stromů |
| `scripts/create_detailed_assets.py`                                           | Podrobné Blender modelování a export vozidel a lidí            |
| `public/data/*.json`                                                          | Distribuovaná geografická data a jejich původ                  |

Ve vývojářské konzoli je dostupné pouze čtecí `tramDebug.snapshot()` a `tramDebug.stats()` pro diagnostiku, včetně celkového času načítání, jednotlivých fází stavby scény v milisekundách a příznaku `prebuiltScenery` pro ověření obnovených ulic. `npm run profile:startup` měří referenční procedurální přípravu celé trasy a geometrie nad skutečnými daty bez předpočítaných ulic, stahování modelů a vykreslování na GPU.
