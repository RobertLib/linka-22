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

Budovy uchovávají původ výšky v `heightSource`. U 42 budov pochází výška přímo z číselného atributu OSM (`OSM`). U 4 452 budov je odvozena z uvedeného počtu podlaží po 3,3 m (`levels`). U 783 je použita označená výchozí výška (`default`). Střešní tvary, barvy a názvy jsou zachovány tam, kde je OSM uvádí. Fasádní vzory, okna, materiály, sochy, mostní konstrukce a většina střech ve vykreslení jsou autorskými vizuálními aproximacemi. Datové půdorysy nejsou fotogrammetrie.

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

## Geografická a architektonická rekonstrukce okolí

`public/data/terrain.json` přidává 3 686 nezměněných výškových vzorků Copernicus GLO-90 přes [Open-Meteo Elevation API](https://open-meteo.com/en/docs/elevation-api). Vzorky jsou v rastru po 180 m v celém obdélníkovém výřezu trasy s přesahem alespoň 850 m; zdrojové rozlišení je 90 m. Úplné pokrytí pozadí zabraňuje výškovým skokům na hranici úzkého koridoru. Bilineární interpolace umožňuje okolním kopcům mít vlastní výšku. V pásu u kolejí se povrch plynule přizpůsobuje jízdnímu profilu; vzdálenější terén postupně přechází na zdrojový model. Voda má samostatnou hladinu a terén pod řekou zůstává níže. Jde o satelitní povrchový model, který může obsahovat vegetaci a střechy, nikoli přesné zaměření základů nebo náspů. Data lze přegenerovat skriptem `scripts/download_terrain.py`; hra pracuje s přiloženým souborem bez externích dotazů.

Šířky okolních ulic nyní přebírají dostupné OSM `width`, `lanes` a `oneway`; chybějící rozměry zůstávají odhadem podle třídy komunikace. Hlavní ulice podél tramvaje je omezena skutečnými půdorysy průčelí a její šířka se mění průběžně. Stejný profil určuje polohu provozu, chodců, vozovky i obrubníků. Chodníky se přerušují v mapovaných příčných vjezdech. Prostorový index zajišťuje, aby se nové stromy nepřekrývaly s budovami, vozovkami nebo vodou. Mimo půdorysy OSM se již negenerují náhodné domy.

Devět budov má doloženou opravu výšky nebo podlaží z převládajících, konzistentně vysokých OSM `building:part`; sedm z těchto oprav mění výšku. Původní údaje, zdrojové části a pokrytí půdorysu zůstávají v metadatech budovy. Skript `scripts/enrich_building_parts.py` odmítá malé věže a nejednoznačné komplexy, které by jinak zvýšily celý půdorys na výšku jediné dominanty. Pokud je uvedeno `roof:height`, kanonická výška stěny vzniká odečtením této výšky od celkové výšky části. Například Kramářova vila má tři podlaží a římsu 11 m podle části s celkovou výškou 15 m a střechou 4 m. Nízké chybné tagy některých paláců bez doložených stavebních částí zůstávají známým omezením dat.

Výška, počet podlaží, tagovaná barva a architektura budov jsou sdílené mezi tělem budovy, fasádou a střechou. Každá fasáda používá souvislý okenní modul a jedno hlavní průčelí se vstupem. Obchodní přízemí se nepřidává palácům, školám a kostelům. U netagované zástavby zůstává typologie odvozená z okolní čtvrti; zejména činžovní domy ve Vršovicích se třemi až šesti podlažími bez explicitně moderních tagů používají tradiční členění. Nejde o ověřenou architekturu každého jednotlivého domu. Výlohy, rámy, závěsy a ornamenty jsou původní generované detaily.

Střechy se orientují podle hran skutečného půdorysu, včetně konkávních polygonů a otevřených dvorů. Tagy `gabled`, `hipped`, `pyramidal` a `mansard` mají odlišné sklonové plochy; ostatní šikmé střechy používají základní aproximaci. Hřebeny složitých křídel a neznámé výšky střech nejsou zaměřené. Komíny a vikýře využívají stejnou výškovou geometrii a zůstávají uvnitř střechy.

Historické chodníky používají originální procedurální mapy černobílé kamenné mozaiky s kamenem 6 × 6 cm. Rozměr a vhodnost pro chodníky kompaktního a historického města vycházejí z [Manuálu tvorby veřejných prostranství IPR Praha, D.1](https://iprpraha.cz/uploads/assets/manual_tvorby_verejnych_prostranstvi/pdf/D.1.pdf). Diamantový vzor není kopií konkrétního chodníku. Povrchy vozovek mají opravené metrové měřítko fotografických textur.

`public/data/skyline.json` obsahuje půdorys katedrály sv. Víta a 133 skutečných OSM `building:part`. Samostatné části určují jejich polohu, výšku a dostupný typ střechy. Dvě západní věže a hlavní jižní věž se výškově řídí údaji [Prague City Tourism](https://prague.eu/en/objevujte/prague-castle-cathedral-of-st-vitus-st-wenceslas-and-st-adalbert-katedrala-sv-vita-vaclava-a-vojtecha/); rozdíly proti OSM jsou uvedeny v `heightOverrides`. Gotická okna, žebrování a křivky barokní helmy jsou původní zjednodušené detaily pro vzdálené pohledy. Extrakci reprodukuje `scripts/download_skyline.py`; jde o další odvozená data OSM pod ODbL, nikoli model poskytovaný Správou Pražského hradu.

## Rozšíření městského prostředí, 14. října 2026

`public/data/city-context.json` znovu zpracovává stejné zdrojové výřezy OSM stažené 13. října 2026. Přidává 8 181 půdorysů okolních budov, které nejsou v původním detailním datasetu, a 1 477 polygonů využití území. Vzdálenější budovy se vykreslují dávkovaně bez detailních oken. Rozšíření nepřidává náhodné domy; mimo dostupné výřezy není úplné. Budovy bez nadzemních podlaží nejsou vykreslené jako nadzemní hmoty. U 377 původních budov doplňuje zachované tagy střech, materiálů a adres. Reprodukce: `python3 scripts/extract-city-context.py --source-dir /cesta/k/OSM/výřezům`.

`public/data/public-spaces.json` zachovává 371 mapovaných ploch veřejných prostranství, 74 vnitřních hranic, 4 677 pěších cest a 1 332 poloh lavic, košů a sloupků. Pramenem jsou stejné XML výřezy OSM, jejichž SHA-256 jsou uložené v metadatech; reprodukci popisuje `scripts/extract_public_spaces.py`. Soukromé a vnitřní cesty, schody a zvýšené mostní cesty nejsou zploštěné na terén. Dlažba vychází z dostupných povrchových tagů, chybějící šířky a vzhled mobiliáře zůstávají odhadem. Geometrie zachovává mapované ostrovy a vynechává budovy, vodu a jízdní koridor. Jemné pěší cesty se vykreslují přibližně do 105 m od trasy. Mapované parky mají přednost před zastavěným využitím území; minerální povrch u půdorysů budov je vizuální přiblížení, nikoli zaměřená dlažba.

Rozměry budov nyní respektují význam [OSM height](https://wiki.openstreetmap.org/wiki/Key:height) a [Simple 3D Buildings](https://wiki.openstreetmap.org/wiki/Simple_3D_Buildings): explicitní celková výška zahrnuje střechu, `building:levels` nezahrnuje podlaží v ní. Pro odhadnuté výšky z podlaží je výška stěny oddělená od střechy. Doložené okapové výšky z převládajících částí mají vlastní původ. Dostupné `roof:height`, `roof:orientation`, `roof:direction` a `roof:angle` určují společnou geometrii střechy, vikýřů a komínů. Neznámé střechy nízkých rodinných domů mají odhadnutý sedlový profil. Fasádní ostění, nátěry a interiéry za skly jsou původní procedurální rekonstrukce, ne fotografie konkrétních domů. Fiktivní názvy obchodů se negenerují.

Jasná obloha `kloppenheim_06_puresky` nyní současně určuje odrazy a směr slunce z nejjasnější části HDR panoramatu. Déšť a podvečer používají odrazy příslušné atmosférické oblohy. Nejde o astronomický výpočet světla podle data a polohy Prahy.

Hlavní vozovka přebírá dostupné OSM povrchy souběžných komunikací v podélných i příčných vzorcích. Tím lze zachovat dlažbu v kolejovém pásu a asfalt vedle něj, pokud je tento rozdíl mapovaný. Příčné silnice se při výběru materiálu vynechávají; nezaměřené okraje materiálů a chybějící tagy zůstávají vizuálním odhadem.

`public/data/landmark-parts.json` doplňuje šest mapovaných objemů kostela sv. Ludmily: hlavní loď, dvě zvonice, sanktusovou věžičku, vstup a schodiště. Obě zvonice mají v OSM celkovou výšku 60 m a střechu 18 m. [Prague City Tourism](https://prague.eu/cs/objevujte/kostel-sv-ludmily/) potvrzuje výšku obou věží a jejich osmiboké jehlanové zakončení. Hra používá zdrojové půdorysy a výšky; okna, žaluzie, ciferníky a členění zdiva jsou zjednodušené vlastní detaily. Nezmapované nižší objemy nejsou vydávané za přesnou rekonstrukci. Zdrojová XML mají uložené hashe a reprodukční skript je součástí projektu.

## Obnovení přesných uličních a kolejových dat, 14. října 2026

`public/data/street-network.json` doplňuje původní městský dataset ze stejných uložených XML výřezů OSM. Obsahuje 3 275 silničních úseků, 484 tramvajových kolejových úseků, 6 214 pěších a cyklistických cest a 50 skutečně mapovaných polygonů vozovek. Všech 3 178 původních silnic a 373 původních kolejových úseků je zachováno podle `osmId`; doplněny jsou také dostupné navazující úseky v koridoru. Geometrie zachovává všechny zdrojové uzly, jejich původní přesnost a identifikátory `nodeIds`. Souřadnice nejsou zjednodušené ani přemístěné. Při výskytu více verzí objektu ve výřezech má přednost nejvyšší OSM verze. Metadata uvádějí verzi, čas objektu, zdrojový soubor a SHA-256 každého XML.

Původní export zahazoval část podstatných údajů o vozovce. Doplněk uchovává všechny zdrojové tagy, včetně `embedded_rails`, `lanes:forward`, `lanes:backward`, `width:lanes`, `placement`, `access:lanes`, parkování a `sidewalk:*`. Explicitní šířku má 108 komunikací, údaj o umístění mapované osy má 40 a `embedded_rails=tram` má 139. [Význam `placement` v OSM](https://wiki.openstreetmap.org/wiki/Key:placement) určuje, vůči kterému pruhu je mapovaná linie vedena; nemusí jít o střed celé vozovky. [Význam `embedded_rails`](https://wiki.openstreetmap.org/wiki/Key:embedded_rails) rozlišuje koleje zabudované do přístupné komunikace od vyhrazeného kolejového pásu. Atribut tak není automatickým důvodem vytvářet další samostatný pruh vedle skutečné silnice.

1 501 komunikací má alespoň jeden tag chodníku. [Značení `sidewalk` v OSM](https://wiki.openstreetmap.org/wiki/Key:sidewalk) rozlišuje chybějící chodník od chodníku mapovaného samostatnou cestou. Soubor zachovává také 59 cest s tagem mostu, které byly v původním exportu veřejných prostranství vynechané. Patří mezi ně obě skutečné osy chodníků mostu Legií, `way/250682927` a `way/250682929`, s povrchem `sett`, `bridge=yes` a `layer=1`. Mostní a tunelové tagy zůstávají zachované, aby renderer mohl oddělit povrchy podle skutečné úrovně. Nezmapované šířky chodníků a výšky konstrukcí zůstávají odhadem.

Kolejové úseky obsahují původní rozchod, jednosměrnost, elektrifikaci, povrch a případné `railway:interlaced`; poslední tag je přítomný na 12 úsecích. Silniční typ `highway=busway` je uchovaný i tam, kde stejná geometrie nese `railway=tram`. Soubor nemění oficiální PID kilometráž a nevydává chybějící geometrické nebo právní údaje za skutečnost. Obrysy vozovek jsou doplněné pouze tam, kde je OSM mapuje; ostatní šířky je nutné odvozovat z dostupných šířek, pruhů, okolních samostatných chodníků nebo označeného odhadu.

Reprodukce bez síťových požadavků: `python3 scripts/enrich-street-network.py --source-dir /cesta/k/OSM/výřezům`. Skript odmítne neúplnou cache, pokud v ní chybí původní silniční či kolejový objekt nebo jeho zdrojový uzel. Původní `city.json` zůstává samostatným zdrojem; doplněk jej může při načtení nahradit podle identity objektů.

## Obrysy vozovek a chodníků z technické mapy IPR

`public/data/street-surfaces.json` přidává fyzické hranice komunikací z veřejné vrstvy [Mapa technického využití území, IPR Praha](https://gs-pub.praha.eu/arcgis/rest/services/dtmp/dtmp/MapServer/15). Zdroj rozlišuje silnice (`701`), chodníky a parkové cesty (`702`), cyklostezky (`703`), parkoviště (`704`) a samostatné tramvajové těleso (`705`). Obecné komunikace (`700`) a další zpevněné plochy (`1003`) jsou zachovány bez domyšleného právního přístupu. Toto členění odpovídá [oficiální legendě MTVU](https://geoportalpraha.cz/backend/getdokument/106). Na rozdíl od osových pěších cest OSM jde o plošné hranice; zachovávají například široké dlážděné prostory a ostrůvky na Malostranském náměstí.

Stažení 14. října 2026 bylo omezené na 27 úseků trasy po nejvýše 800 m s dotazovým přesahem 180 m. Jedinečné zdrojové objekty se následně vybírají pouze pro koridor 100 m od linky 22. Výsledkem je 2 042 polygonových částí z 1 850 zdrojových objektů: 92 silničních ploch, 913 chodníkových ploch, 36 tramvajových těles, 189 parkovacích ploch, 5 cyklistických ploch a 807 obecně zpevněných ploch. Soubor zachovává 128 718 vrcholů a 1 124 otvorů. ArcGIS převádí zdrojové S-JTSK do WGS84, zakřivené geometrie exportuje jako lomené linie. Souřadnice nejsou dodatečně zaokrouhlené ani zjednodušené.

Rozsáhlé zdrojové silniční sítě přesahují jednotlivé městské části; jejich celé geometrie by nepřiměřeně zatížily scénu. Skript je proto ořezává pouze na vnější hranici koridoru. Původní lokální hranice zůstávají zachované; 1 860 umělých ořezových hran je výslovně označených v `clipEdges` a `clipHoleEdges` a nesmí představovat skutečné obrubníky. Neplatná topologie 33 zdrojových objektů je normalizovaná funkcí Shapely `make_valid`; jejich identifikátory jsou uvedené v metadatech. Materiál povrchu, povolení automobilové dopravy a výškové úrovně se z kategorie technického využití nedají zjistit a zůstávají oddělenými údaji OSM a výškového modelu.

Jde o archivní zdroj DTMP, nikoli ověření všech rekonstrukcí ulic k říjnu 2026. Zachované atributy `DAT_VZNIK` mají datum 1. května 2024; toto datum objektu není prohlášením o datu zaměření každé hrany. Polygon silnice, tramvajového tělesa nebo obecné komunikace pokrývá 95,193 % vzorků původní trasy po 10 m. Dvanáct chybějících intervalů je vypsáno v `coverage.missingRoadTramIntervals`. Nula polygonů v dotazovaném místě není důkazem trávy ani přesného chodníku. Přesnost uložení souřadnic a `xyTolerance` služby nejsou zárukou absolutní geodetické přesnosti.

[Pravidla poskytování dat GIS hl. m. Prahy, část I.8](https://geoportalpraha.cz/backend/getdokument/1) povolují užití veřejných mapových prohlížecích a stahovacích služeb pod CC BY 4.0 s uvedením změn a doložkou „datový podklad © IPR Praha“. Dataset uchovává zdrojové URL, SHA-256 všech odpovědí, licenční pravidla a popis změn. Reprodukce vyžaduje Shapely 2 a cache vytvořenou příkazem `python3 scripts/download-street-surfaces.py --cache-dir /cesta/k/cache --download`; stejné spuštění bez `--download` pracuje offline. `node scripts/test-street-surfaces.mjs` kontroluje zdrojové záznamy, omezený rozsah dotazů, přesné průniky včetně otvorů, skutečné chodníkové hranice Malostranského náměstí, ořezové hrany a přiznaná nepokrytá místa. Proměnná `IPR_SOURCE_DIR` přidává kontrolu hashů proti původní cache.

## Licence a uvedení zdrojů

- Trasa a zastávky: ROPID / PID, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Změny: výběr jedné varianty, převod vzdáleností na metry a vlastní JSON struktura.
- Městská geodata: © OpenStreetMap contributors, [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/). `city.json` je odvozená databáze pod touto licencí. Změny: výběr koridoru, zjednodušení geometrie a doplnění odhadů výšky. [Informace OSM o uvedení zdroje](https://www.openstreetmap.org/copyright).
- Výšková data: Copernicus DEM / [Open-Meteo](https://open-meteo.com/), [CC BY 4.0](https://open-meteo.com/en/licence). Změny: vyhlazení a herní úprava profilu. Doporučená citace zdroje Copernicus DEM: [DOI 10.5270/ESA-c5d3d65](https://doi.org/10.5270/ESA-c5d3d65).
- Technické informace o vozidlech: veřejné technické karty DPP, odkazy výše. Vytvořené 3D modely nejsou modely poskytnuté DPP.
- Fotografické povrchy, HDR a strom: Poly Haven, [CC0 1.0](https://polyhaven.com/license). Úpravy stromu: decimace a export GLB v Blenderu. Referenční fotografie kabiny se nešíří.

## Ověření datasetů

`node scripts/test-route.mjs` ověřuje počet a směr zastávek, běžnou variantu bez výluky, geografické rozsahy, jednotky a monotónní kilometráž, konečnou délku, chybějící úseky, projekci zastávkových sloupků do 50 m od trati, rozumné výšky a souvislý sklon. Zároveň kontroluje přítomnost skutečného města, uzavření polygonů, datové počty, geografické souřadnice a původ výšek budov. Při přípravě prošly všechny kontroly.
