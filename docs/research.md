# Praha — tramvajová linka 22: zdroje a přesnost

Zpracováno 13. října 2026. Simulovaná varianta je běžný celý směr **Bílá Hora → Nádraží Hostivař**, nikoli některý zkrácený spoj nebo výluková varianta. Jde o herní zpracování veřejných geografických dat a technických referencí; nejde o profesionální výcvikový simulátor DPP.

## Skutečná trasa a zastávky

`public/data/route22.json` vychází přímo z oficiálního [PID GTFS](https://data.pid.cz/PID_GTFS.zip), publikovaného ROPID. Stažený feed platí 13.–26. října 2026. Vybrána je geometrie `L22V12` a spoj `22_40690_260811`, který projíždí běžnou celou trasu. Soubor obsahuje 660 geografických bodů, 44 zastávek ve správném směru a řetězec dlouhý 20 993,69 m. Původní kilometrické hodnoty `shape_dist_traveled` byly převedeny na metry. Zastávkové souřadnice odpovídají konkrétním směrovým sloupkům, nikoli průměrným středům zastávkových uzlů.

Výběr spoje poskytuje odjezd z Bílé Hory v 19:19 a příjezd do Hostivaře ve 20:24; jde o konkrétní publikovanou 65minutovou jízdu. Aktuální živé odjezdy, přesná obsazenost ani denní změny provozu se nestahují během hry. [Dokumentace a licence otevřených dat PID](https://pid.cz/o-systemu/opendata/) vysvětluje význam souborů a rozlišuje běžné spoje od vozovnových nájezdů.

[Zastávkové jízdní řády linky 22](https://pid.cz/zastavkove-jizdni-rady/?cid=22&from=1791669600&type=tram) byly použity pro kontrolu jmen a vedení linky. Feed obsahuje také říjnové výlukové varianty přes Hradčanskou; ty byly vědomě vyřazeny. Starší název Hellichova již neodpovídá současnému směru: od 28. června 2025 se stanoviště směrem na Újezd jmenuje Pražské Jezulátko a v opačném směru Tyršův dům. Viz [oficiální oznámení PID](https://pid.cz/prejmenovani-tramvajove-zastavky-hellichova-od-28-cervna/).

GTFS geometrie je skutečný mapový průběh linky. Není však geodetickým zaměřením osy pravé koleje, přesných přechodnic nebo příčného převýšení. Nejdelší úsek mezi dvěma zdrojovými body je 421 m; průjezd těmito úseky je interpolován. Jednotlivé zastávkové sloupky leží při kontrolní projekci nejvýše 6 m od zdrojové křivky, což odpovídá poloze sloupku vedle koleje.

## Skutečné půdorysy města

`public/data/city.json` obsahuje samostatný odvozený dataset z [OpenStreetMap](https://www.openstreetmap.org/). Veřejná služba Overpass nebyla v době přípravy dostupná; data byla získána 21 omezenými výřezy přes [OSM map API](https://wiki.openstreetmap.org/wiki/API_v0.6#Retrieving_map_data_by_bounding_box:_GET_/api/0.6/map), doplněnými výřezem centra a úplnou relací vodního polygonu Vltavy. Tím je pokryta celá linka včetně Malé Strany, Újezdu, mostu Legií, Národního divadla, Vinohrad, Vršovic, Strašnic a Hostivaře.

Do herního datasetu byly vybrány budovy zhruba do 185 m od trasy, komunikace do 220 m, stromy do 180 m a větší plochy zeleně v širším okolí. Velmi malé objekty a drobné pásy trávníku jsou vynechány. Křivky jsou zjednodušeny s tolerancí 0,55 m a souřadnice zaokrouhleny na šest desetinných míst. Soubor má přibližně 2,8 MB, aby se město nemuselo stahovat z externí služby při spuštění.

| Obsah                     | Počet | Co je skutečné                                                    |
| ------------------------- | ----: | ----------------------------------------------------------------- |
| Budovy                    | 5 277 | Geografické půdorysy OSM                                          |
| Silniční úseky            | 3 178 | Geometrie, typy a dostupné názvy                                  |
| Vodní plochy              |    33 | Půdorysy včetně Vltavy                                            |
| Větší plochy zeleně       |   477 | Půdorysy parků, zahrad a zelených ploch                           |
| Stromy                    | 1 486 | Mapované polohy; vykreslení optimalizovaným fotografickým modelem |
| Signální body             |   217 | Mapované semafory poblíž trasy                                    |
| Tramvajové kolejové úseky |   373 | Dostupné mapové geometrie skutečných kolejí                       |

Budovy uchovávají původ výšky v `heightSource`. U 41 budov pochází výška přímo z číselného atributu OSM (`OSM`). U 4 453 budov je odvozena z uvedeného počtu podlaží po 3,3 m (`levels`). U 783 je použita označená výchozí výška (`default`). Střešní tvary, barvy a názvy jsou zachovány tam, kde je OSM uvádí. Fasádní vzory, okna, materiály, sochy, mostní konstrukce a většina střech ve vykreslení jsou autorskými vizuálními aproximacemi. Datové půdorysy nejsou fotogrammetrie.

Vnější hranice vícečástových budov, dvorů a vodních ploch jsou sestaveny z relací OSM. Dostupné vnitřní hranice jsou předány jako `holes`, včetně ostrovů ve Vltavě; jejich správné vykreslení závisí na podpoře otvorů v geometrii scény. Souřadnice všech polygonů mají pořadí `[latitude, longitude]`.

## Výškový profil

Výšky byly získány pro všech 660 bodů trasy a 44 zastávek přes [Open-Meteo Elevation API](https://open-meteo.com/en/docs/elevation-api). Zdrojem je Copernicus DEM 2021 GLO-90 s rozlišením 90 m. `terrainElevation` uchovává nezměněný vzorek a `elevation` profil pro scénu: vzdálenostní Gaussovo vyhlazení se sigma 140 m, omezení sklonu přibližně na ±7,5 % a interpolaci přes most Legií. Profil tak zachovává hlavní pokles od Bílé Hory k Vltavě a další kopce východní části Prahy. Scéna používá `baselineAltitude: 190`, tedy výšku světa `elevation − 190`.

Satelitní model může zahrnovat střechy a vegetaci; devadesátimetrový rastr nemůže zachytit přesnou výšku kolejnice, kolejové sklony, zářezy nebo výšku mostní vozovky. Vyhlazený profil je proto přiznaná herní aproximace založená na skutečném výškovém modelu, nikoli přesný traťový profil. Výšky budov mimo osu tratě jsou ve scéně interpolované.

## Referenční tramvaj

[Technická karta DPP — Tatra T3R.P](https://www.dpp.cz/vozovy-park/tramvaje/tatra-t3r-p) uvádí šířku 2,500 m, délku přes spřáhla 15,104 m, výšku 3,060 m, hmotnost 17,3 t, výkon 4 × 40 kW a nejvyšší provozní rychlost 65 km/h. Vůz má tři dveře a kapacitu 69 stojících a 22 sedících cestujících. Tyto údaje jsou referencí pro rozměry a koncepci modelu vytvořeného v Blenderu. Přesné provozní dynamické koeficienty, závislosti brzdné síly, jízdní odpory a nastavení kontroléru nejsou z této karty zjistitelné a herní fyzika je aproximuje.

Pro srovnání [technická karta DPP — Škoda 15T](https://www.dpp.cz/vozovy-park/tramvaje/skoda-15t) uvádí délku 31,4 m, šířku 2,46 m, hmotnost 43,8 t a nejvyšší provozní rychlost 60 km/h. Pravidelná linka není v tomto projektu tvrzena jako provoz výhradně jednoho konkrétního typu tramvaje.

Mapované semafory slouží k umístění scénických objektů. Skutečné signální programy křižovatek, preference tramvají, dispečerské řízení, vozidla před hráčem, obsazenost a pohyb ostatní dopravy jsou herní modely. Použitá simulace neodpovídá skutečnému aktuálnímu provozu.

## Grafická rekonstrukce a provoz, verze 2

Nové modely T3R.P a kabiny byly vytvořeny v Blenderu v metrovém měřítku podle technické karty DPP a [referenčního snímku kabiny 8335](https://www.prazsketramvaje.cz/obrazky/vozyosobni/8335-001.jpg). Fotografie slouží jen jako vizuální reference; ve hře ani zdrojovém balíčku není redistribuována. Model obsahuje troje skládací dveře, podvozky, interiér, palubní desku, ručku rychloměru a pantograf. Nejde o originální CAD výrobce. Nové automobily a kloubově animované postavy jsou také původní Blender modely.

Fotografické materiály jsou z oficiálního [Poly Haven API](https://api.polyhaven.com): `cobblestone_floor_02`, `pavement_03`, `asphalt_02`, `plastered_wall_02`, `roof_tiles_14`, `ceramic_roof_01` a `aerial_grass_rock`. Pro každý jsou přiloženy barva, OpenGL normálová mapa a drsnost. HDR `urban_alley_01` osvětluje odrazy a `kloppenheim_06_puresky` tvoří jasnou oblohu. `tree_small_02` je původní fotografický strom optimalizovaný v Blenderu; zachovává UV a zdrojové materiály, snižuje počet plošek pro reálné vykreslování. Listy zachovávají celý obrys, blízké stromy mají plnou geometrii a vzdálené používají průhledný Blender render stejného modelu. Všechna tato díla lze distribuovat a upravovat pod [CC0 podle Poly Haven](https://polyhaven.com/license). Přesný seznam odkazů je v `public/textures/manifest.json`, download skripty ověřují původní MD5 z API.

Jde o skutečné fotografické povrchy a vlastní rekonstrukci fasád. Textury nepocházejí ze skenu konkrétních pražských budov. 3D okna, římsy, plinty, výlohy a balkony využívají skutečné půdorysy a dostupná podlaží, ale jejich vzhled je generovaný. Rozměry neznámých ulic, chodníků a nástupišť jsou stále odhadované; nástupiště nyní sledují výškový profil a oblouk.

`public/data/crossings.json` doplňuje 495 přechodových uzlů a 440 cest typu `footway=crossing` ze stejných původních výřezů OSM. Umístění je mapové, signální cykly jsou simulované. Podrobnosti front, předností, nástupu, kolizí a úrovní detailu jsou v [traffic.md](traffic.md); sílová fyzika, známé hodnoty DPP a odhadnuté koeficienty v [physics.md](physics.md).

Průjezd Oettingenským palácem před ústím Letenské ulice má ve scéně vyříznuté spodní stěny podle skutečného půdorysu a křivky tratě. Historická existence kolejové splítky je popsána v časopise DPP [DP-KONTAKT 1/2004, strana 2](https://www.metroweb.cz/dp-kontakt/2004/01_2004.pdf). Šířka portálu 4 m, světlá výška 6,2 m, náběhy splítky a rychlostní omezení 15 km/h jsou vizuální/herní odhady. Protijedoucí doprava před průjezdem čeká na hráčovu soupravu. Není to zaměřená dokumentace stavby.

Model sv. Mikuláše používá výšku kupole i zvonice 79 m a průměr kupole 20 m uvedené na [oficiálním webu kostela](https://www.stnicholas.cz/o-kostele/). Polohou se řídí půdorysy OSM; průčelí míří na západ. Střecha Národního divadla je tmavá se zlacenou korunou podle [oficiálních fotografií divadla](https://www.narodni-divadlo.cz/). Ozdobné detaily jsou zjednodušené Blender rekonstrukce.

## Licence a uvedení zdrojů

- Trasa a zastávky: ROPID / PID, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Změny: výběr jedné varianty, převod vzdáleností na metry a vlastní JSON struktura.
- Městská geodata: © OpenStreetMap contributors, [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/). `city.json` je odvozená databáze pod touto licencí. Změny: výběr koridoru, zjednodušení geometrie a doplnění odhadů výšky. [Informace OSM o uvedení zdroje](https://www.openstreetmap.org/copyright).
- Výšková data: Copernicus DEM / [Open-Meteo](https://open-meteo.com/), [CC BY 4.0](https://open-meteo.com/en/licence). Změny: vyhlazení a herní úprava profilu. Doporučená citace zdroje Copernicus DEM: [DOI 10.5270/ESA-c5d3d65](https://doi.org/10.5270/ESA-c5d3d65).
- Technické informace o vozidlech: veřejné technické karty DPP, odkazy výše. Vytvořené 3D modely nejsou modely poskytnuté DPP.
- Fotografické povrchy, HDR a strom: Poly Haven, [CC0 1.0](https://polyhaven.com/license). Úpravy stromu: decimace a export GLB v Blenderu. Referenční fotografie kabiny se nešíří.

## Ověření datasetů

`node scripts/test-route.mjs` ověřuje počet a směr zastávek, běžnou variantu bez výluky, geografické rozsahy, jednotky a monotónní kilometráž, konečnou délku, chybějící úseky, projekci zastávkových sloupků do 50 m od trati, rozumné výšky a souvislý sklon. Zároveň kontroluje přítomnost skutečného města, uzavření polygonů, datové počty, geografické souřadnice a původ výšek budov. Při přípravě prošly všechny kontroly.
