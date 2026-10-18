# Fyzika tramvaje a její ověření

`src/simulation.js` odděluje simulaci od Three.js. Integruje síly v newtonech,
hmotnost v kilogramech, rychlost v m/s a čas v sekundách po krocích nejvýše
1/60 s. `s` je poloha čela tramvaje po trase. `getGrade(s)` vrací poměr
převýšení a vodorovné délky; `0.04` je stoupání 4 %. `getCurveRadius(s)` vrací
poloměr oblouku v metrech se znaménkem směru zatáčky. `Infinity` znamená přímou
trať. Zastávky a stop čáry používají stejnou délkovou referenci.

## Co je doloženo primárními zdroji

T3R.P má prázdnou hmotnost 17 300 kg, čtyři trakční motory po 40 kW, délku přes
spřáhla 15,104 m, šířku 2,5 m a maximální provozní rychlost 65 km/h. Kapacita
je 22 sedících a 69 stojících. Souprava dvou vozů proto má 34,6 t bez
cestujících a 320 kW instalovaného výkonu. Zdroj: [DPP – Tatra T3R.P](https://www.dpp.cz/vozovy-park/tramvaje/tatra-t3r-p), ověřeno 13. října 2026.

Použití pulzní výzbroje TV Progress, možnost vracení brzdné energie do vedení,
protiskluzová/protismyková ochrana a elektrické pískovače jsou popsány přímo
Dopravním podnikem v [DP Kontakt 11/2022, článek o modernizacích T3](https://www.dpp.cz/data/leaflets/documents/2022-11-28-08-06-53_DP-kontaktlistopad-2022-web.pdf).
Model proto odděluje elektrodynamickou brzdu, mechanické dobrzdění, adhezi
kolo–kolejnice a pískování. Nejde o přepis neveřejného regulátoru TV Progress.

Volitelný profil 15T používá údaje pražského provozovatele: 43,8 t, 31,4 m,
šířku 2,46 m, provozní maximum 60 km/h, kapacitu 199 a výkon 16 × 46,6 kW,
tedy 745,6 kW. Zdroj: [DPP – Škoda 15T](https://www.dpp.cz/vozovy-park/tramvaje/skoda-15t).
[Obecná stránka výrobce pro pražskou ForCity Alfa](https://www.skodagroup.com/reference/tramcar-forcity-alfa-prague)
uvádí 720 kW; v herním profilu je upřednostněn aktuálně zveřejněný údaj DPP.
Jízdní síly profilu 15T se škálují podle hmotnosti, jeho detailní motorové
mapy nejsou samostatně změřeny. Výchozí hra modeluje soupravu T3R.P.

## Pohyb podle sil

Základní rovnice je `a = (Ftrakce − Fbrzdy − Fodpor − Fsklon) / mefektivní`.
Efektivní hmotnost zahrnuje 7% přírůstek na rotační setrvačnost kol a pohonu;
cestující přidává předpokládaných 75 kg. Tyto dvě hodnoty jsou modelové
předpoklady. Skutečná síla ve svahu je `m × g × grade / sqrt(1 + grade²)`.

Při rozjezdu je tah omezen momentem: nejvýše 26 kN na vůz. Při vyšší rychlosti
jej omezuje výkon `F = P / v` a vždy také dostupná adheze `F ≤ μ × m × g`.
Přidání cestujících proto ovlivňuje zrychlení i energii. Síla narůstá plynule
s předpokládaným rázem 0,7 m/s³; při přechodu do brzdění 0,9 m/s³. U nouzové
brzdy je náběh rychlejší, 4,5 m/s³. Omezuje se změna síly motorů a brzd;
gravitace se nepřevádí na uměle pomalou změnu zrychlení.

Rychlost 65 km/h vypíná trakci. Pohyb se na této rychlosti neořízne: ve spádu
může tramvaj zrychlit nad provozní maximum a řidič musí brzdit. Traťové
rychlosti, zastávky ani červené návěsti samy nesnižují rychlost hráče.

Jízdní odpory mají tvar Davisovy aproximace: valivá složka úměrná hmotnosti,
lineární složka úměrná rychlosti a aerodynamická složka úměrná `v²`. V oblouku
přibývá odpor vedení kol po kolejnicích podle `m × g × 0,45 / |R|`. Použité
součinitele jsou otevřeně uvedeny v exportu `PHYSICS`; nejsou vydávány za
měření konkrétního pražského vozu.

## Brzdy, déšť a písek

Plné provozní brzdění požaduje 32 kN na vůz. Elektrodynamická brzda je omezena
silou a krátkodobým výkonem nejvýše dvojnásobku trakčního výkonu. Pod 1,8 m/s
její účinek plynule klesá s rychlostí; současně se přidává mechanická brzda.
V nulové rychlosti elektrodynamická brzda nedrží, drží mechanická. Tento
přechod brání nereálnému elektrickému brzdění v úplném zastavení.
Mechanická brzda doplňuje také chybějící sílu při výkonovém omezení
elektrodynamické brzdy ve vysoké rychlosti. Požadavek řadiče se tedy při
nedostatku elektrického brzdného výkonu neztrácí.

Nouzové brzdění požaduje 40 kN na vůz na kolech a přidává 20 kN na vůz
kolejové brzdy; v dešti je kolejová složka předpokládaně o 10 % nižší.
Kolejová brzda má modelovaný náběh 0,2 s, takže v jediném integračním kroku
nepřidá skokem celou brzdnou sílu.
Kolejová brzda se neomezuje součinitelem adheze kol. Brzdění na kolech se
omezuje stejně jako trakce dostupnou adhezí; při smyku se účinek regulátoru
snižuje o další 4 %. Všechny uvedené brzdové síly, náběhy a prahy jsou
kalibrované herní předpoklady, nikoli zveřejněná brzdová zkouška T3R.P.

Výchozí adheze je 0,23 na suchu a 0,085 při dešti. Pískování ji s náběhem
0,5 s zvedá na 0,26 / 0,15. Po uvolnění pískovače účinek během přibližně
dvou sekund odeznívá. `setSanding(true/false)` ovládá hráč podržením G.
`wheelSlip` je poměr požadované síly přesahující dostupnou adhezi v rozsahu
0–1, nikoli přesná úhlová rychlost jednotlivé nápravy.

Déšť tedy nemění hmotnost ani výkon motorů. Sníží sílu, kterou kola dokážou
přenést, a při vysokém požadavku vznikne skluz nebo smyk. Na strmém pražském
spádu může bez písku zbýt velmi malá čistá decelerace. Řidič musí snížit
rychlost předem a použít písek; nouzová kolejová brzda je samostatná rezerva.

Nová a obnovená služba začíná zabrzděná. Výslovné zvolení řadiče, včetně
výběhu 0, uvolní počáteční parkovací brzdu. Výběh pak na klesající koleji
nedrží ani stojící tramvaj. Zámek dveří a ukončená služba používají skutečný
požadavek mechanické brzdy. Pohyb dozadu, samostatná dynamika jednotlivých
kol, vykolejení a deformace skříně se zatím nemodelují.

`getBrakingDistance({ emergency, reactionTime })` integruje stejnou brzdovou
charakteristiku, náběh síly, zatížení, adhezi a sklon podél předpokládané
brzdné dráhy. Základní doporučení přidává 0,8 s reakce řidiče. Nouzová
projekce reakční čas nepřidává. Během reakce působí dosavadní síla řadiče a
gravitace, takže se ve spádu může zvýšit i rychlost při zahájení brzdění.
Pokud model nedokáže do 180 s zastavit,
metoda vrátí `Infinity`. Pro HUD je údaj `brakingDistance` omezen na 1000 m
a doprovázen příznakem `brakingUnsafe`, takže aplikace může zobrazit varování.
Projekce čte místní adhezi v každém bodě budoucí dráhy, pokračující změnu
vlhkosti koleje i teplotu mechanické brzdy. U pískování předpokládá aktuální
intenzitu, nikoli budoucí aktivaci nebo další náběh písku.

## Místní adheze a paměť počasí

Vlhkost koleje není totožná s přepínačem počasí. Při změně na déšť roste
`railWetness` exponenciálně s časovou konstantou 18 s. Po přepnutí na jasno
schne s časovou konstantou 300 s; mokrá trať tedy nezíská v jednom snímku
suchou adhezi. Nová deštivá jízda začíná na již mokré trati. Tyto časy jsou
herní aproximace, nikoli hydrologické měření Prahy.

Konfigurace `railConditions` přijímá úseky například
`{ startS: 100, endS: 240, condition: "leaves", severity: 0.55,
transitionMeters: 8, label: "Listí pod stromy" }`. Podporuje `wet`, `leaves`
a `grease`; místní `getRailCondition(s, { weather, time, railWetness })`
může alternativně vrátit stejné údaje, řetězec druhu povrchu nebo `null`.
Začátek a konec úseku mají hladký náběh. Dva reprezentativní kontakty
podvozků každého vozu vzorkují kolej samostatně. Čelo v krátkém úseku proto
nezmění adhezi celé soupravy naráz a zadní vůz může být na listí ještě
po výjezdu čela. Výsledná síla používá průměr dostupné adheze kontaktů;
nejde o samostatný regulátor každé nápravy ani přesný rozklad zatížení 15T.

Listí v plně znečištěném úseku má modelovanou adhezi 0,10 za sucha a 0,035
za mokra, mastné znečištění 0,045. `severity` míchá tento povrch s běžnou
kolejí. Písek zvyšuje adhezi listí na 0,13 a mastného povrchu na 0,11;
nesmaže samotný znečištěný úsek. Tyto hodnoty a účinnost písku jsou otevřená
kalibrace hry. Je doložen samotný mechanismus: RSSB uvádí směs vlhkosti
a listového filmu i vliv mastnoty a rzi na nízkou adhezi a účinnost
pískování. Zdroj: [RSSB – Adhesion](https://www.rssb.co.uk/research/flagship-research-activities/adhesion).
Vyšetřovací zpráva RAIB řadí adhezi pod 0,05 do mimořádně nízké kategorie
a spojuje ji se silným znečištěním. Zdroj:
[RAIB – Talerddig, zpráva 8/2026](https://assets.publishing.service.gov.uk/media/6a3270a900ff27f06e3ef93c/R082026_260618_Talerddig.pdf).
Nejde o měření konkrétní pražské koleje.

Snapshot vrací `railCondition`, `railConditionLabel`, `railConditionSeverity`,
`railWetness`, `adhesionCoefficient` a nejbližší `nextRailCondition` do 180 m.
V kontrolní jízdě z 43,2 km/h na mokré přímé koleji se provozní zastavení
prodlouží z 96,1 m na 133,2 m při listí závažnosti 0,65 v úseku 20–200 m.
Předem rozběhnuté pískování zkrátí zastavení na 63,9 m a nouzová kolejová
brzda na 47,2 m. Projekce se v těchto scénářích liší od skutečné integrace
o méně než 1,5 m. Jsou to reprodukovatelné výsledky hry, nikoli brzdové
zkoušky nebo doporučení pro řízení skutečného vozidla.

## Energie, proudy a pohyb skříně

Mechanická práce motorů je `Ftrakce × v`. Odběr z vedení započítává
předpokládanou účinnost 88 %, měděné ztráty rostoucí s druhou mocninou síly
a pomocné spotřebiče 2,5 kW na vůz. `powerKW` je mechanický výkon motorů,
`tractionCurrentA` odhad trakčního proudu odebíraného z 600V vedení a
`brakeCurrentA` odhad vyrobeného elektrodynamického proudu. Nejde o proud
každého jednotlivého motoru. `lineCurrentA` zahrnuje pomocné spotřebiče a
energii skutečně vracenou do vedení; při rekuperaci může být záporný.

Předpokládaná účinnost výroby při brzdění je 72 %. `regenerationReceptivity`
určuje, jakou část vyrobené energie vedení přijme (výchozích 60 %).
Nepřijatá část přejde do odporníku; brzdná síla se tím nesníží. Počitadla
`consumptionKWh`, `regeneratedKWh`, `netEnergyKWh` a `resistorHeatKWh` se
počítají z práce a času. Uložení uchovává spotřebu, rekuperaci a energii
odporníku, aby obnovení jízdy nevymazalo bilanci.

Oblouk vytváří příčné zrychlení `v² / R`, které vrací `lateralAccel`.
`chassisRoll` je v radiánech a používá tlumené odpružení, `chassisPitch`
reaguje na podélné zrychlení. `rideShake` představuje drobný zdvih v metrech
od kolejových spojů a drobných nerovností; v klidu je nulový. Vizuální
součinitele odpružení a nerovností jsou aproximace. Nezvyšují přímo tah nebo
brzdnou sílu a nemohou ovlivnit podélnou energetickou bilanci.

## Teplo brzd a stabilita cestujících

Mechanická práce třecích brzd přechází do `mechanicalBrakeHeatKWh` a zvyšuje
`brakeTemperatureC`. Energie odmítnutá vedením zahřívá
`resistorTemperatureC`; plná rekuperace tuto větev nezahřívá. Obojí má
samostatné chlazení zesílené prouděním při jízdě. Používá se přesné řešení
jednoduché tepelné rovnice v integračním kroku, aby velký snímek nezpůsobil
nestabilní ochlazení. Zajištěná stojící tramvaj nekoná brzdnou práci a brzdy
se při stání nezahřívají.

Tepelná kapacita referenčního vozu je předpokládaných 100 kJ/K pro třecí
brzdy a 180 kJ/K pro odporníky. Chlazení je `(180 + 25 × v)` a
`(600 + 30 × v)` W/K; kapacity i celkové chlazení se škálují podle hmotnosti
profilu a počtu vozů. Výchozí okolí má 18 °C, konfigurace může zadat
`ambientTemperatureC`. Pod 300 °C se síla mechanické brzdy nemění. Při
extrémním přehřátí mezi 300 a 700 °C plynule klesá až na 45 % přes
`frictionBrakeFactor`. Elektrická a kolejová brzda zůstávají nezávislé.
Normální zastávková služba nevytváří náhodný výpadek brzd. Teploty, kapacity,
chlazení i hranice slábnutí jsou herní předpoklady; nejsou doloženy jako
skutečné tepelné limity brzd T3R.P.

`comfortStress` kombinuje podélné a příčné zrychlení s vyhlazeným rázem;
`comfortRating` v rozsahu 0–100 hodnotí dosavadní dobu pohybu. Stání hodnocení
nevymaže. `passengerSway` v metrech je tlumená výchylka reprezentativního
stojícího cestujícího v podélném a příčném směru. Její dynamika reaguje
na zrychlování, brzdění a oblouky a po zastavení postupně dohasne.

Trvající vysoká kombinovaná zátěž
`hypot(a / 1.25, lateralAccel / 1.4) > 1.6` delší než 0,8 s vyvolá jednu
událost `violations.roughRide`, upozornění a mírný postih 8 bodů. Běžné
provozní brzdění, krátký ráz ani nouzové brzdění tento dodatečný postih
nezpůsobí; prázdný vůz jej nedostane. Prahy i hodnocení jsou kalibrovaná
zpětná vazba pro hru, nikoli zdravotní model cestujících.

## Střety a obsluha zastávek

`reportCollision()` přijímá původní číselnou závažnost nebo údaje kontaktu
včetně `otherMass`, `otherVelocity`, `contactNormal`, `tramDirection`,
`contactOffset`, `otherInertia` a `otherAngularVelocity`. Městský provoz
získává normálu z testu oddělujících os orientovaných obrysů. Impuls vychází
z relativní rychlosti v místě kontaktu, hmotností, ramene zásahu a rotační
setrvačnosti auta; tramvaj zůstává omezena tečnou koleje. Výchozí restituce
je 0,05, městské kontakty používají 0,04. Střet s 1,5t autem proto nevymaže
většinu hybnosti soupravy. Klidový nebo vzdalující se průnik nepřidává náraz.

Auto přebírá světový impuls, při zásahu mimo střed i úhlovou rychlost.
Po odstranění geometrického průniku pokračuje volným posunem a rotací;
aproximované tření klouzajících či zablokovaných pneumatik jej postupně
zastaví. Jízdní AI jej nevrací na původní dráhu. Bilance ztracené energie
zahrnuje podélný pohyb tramvaje, oba směry pohybu auta a jeho rotaci.
`collisionEnergyKJ` ji sčítá a `damage` převádí na trvalé poškození;
velké poškození omezuje dostupný výkon.

`src/vehicle-physics.js` řeší také střety aut mezi sebou. Jedoucí, křižující
i zaparkované auto má konečnou hmotnost a rotační setrvačnost
`I = m × (šířka² + délka²) / 12`. Impuls v místě kontaktu mění rychlost
a rotaci obou aut; restituce je 0,04 a součinitel Coulombova tření kontaktu
0,35. Geometrická korekce rozděluje posun podle převrácených hmotností
a sama nepřidává kinetickou energii. Po krocích nejvýše 1/60 s se kontakty
opakovaně řeší spolu s tramvají omezenou kolejí, aby hybnost i odstranění
průniku prošly celou nabranou frontou. Auto zasažené jiným autem pokračuje
ve stejném volném režimu vraku; tyto sekundární střety samostatně
nezapočítávají hráčovy bodové postihy.

První náraz aktivuje nouzovou brzdu a započte jednu kolizní událost.
Pokračující kontakt může dál přenášet impuls a disipovat energii, ale
neopakuje bodový postih ani zvuk nehody. `lastCollisionImpact` obsahuje
čas, normálu, impuls a rychlosti před i po kontaktu; `collisionCount`
počítá události. `impactShake` postupně tlumí otřes odpružení.
Procedurální zvuk spojuje tupý úder, nízký dozvuk a krátké kovové
zachrastění; hlasitost závisí na energii a změně rychlosti. Je to přibližný
kontakt tuhých těles, nikoli úplný deformační model nebo certifikovaný
výpočet nehody.

Obsluha zastávky vyžaduje stání v toleranci 18 m od označníku, správnou
stranu dveří, dokončené otevření a souvislý nástup. Při jízdě podle
jízdního řádu trvá nástup podle počtu vystupujících a nastupujících
`4,5 s + (1,25 s × nastupující + 0,8 s × vystupující) / 3,2`, nejméně 8 s
a nejvýše 45 s; bez jízdního řádu zůstává pevných osm sekund. Obsloužení
se započte až po zavření a zajištění dveří. Zastávku na znamení
(`stop.request`) lze bez postihu projet, jen když nikdo nevystupuje ani
nečeká. Odjezd podle jízdního řádu se vyhodnotí, až čelo opustí nástupiště
o 1,5 m nebo souprava přesáhne 0,6 m/s: předčasný odjezd o více než 5 s
znamená −60 bodů, odjezd do +180 s +20 bodů.

Rychlostní omezení `getSpeedLimit(s)` se vyhodnocuje po 3 m od čela až po
zadní spřáhlo soupravy. Snížená rychlost tak platí, dokud úsekem neprojede
i poslední vůz, a teprve potom se smí zrychlit. `nextLimit` hlásí první
nižší omezení před čelem do 320 m. Návěstidla používají
`getSignalAspect(signal, time)`; městský provoz čte stejný čas. Cykly
křižovatek jsou herní simulace. Délky otevírání a zavírání dveří a pobyty
nepředstavují skutečný služební předpis DPP.

`getSaveState()` uchovává polohu, další zastávku, skóre, cestující, čas,
přestupky, energetickou bilanci, poškození i již dokončený nástup.
Uchovává také vlhkost koleje, obě teploty, práci třecích brzd a historii
komfortu. Obnovení neochladí přehřátou brzdu ani nevymaže mokrou kolej.
Obnovení začíná se zavřenými dveřmi, nulovou rychlostí a parkovací brzdou.
Dokončená obsluha se započte právě jednou; cestující se nevymění podruhé.

## Ověření

`node scripts/test-simulation.mjs` má 42 testů. Ověřuje mimo jiné výkonový
limit, rovnici sil, kinetickou energii proti vykonané práci, soulad
rekuperované energie s dostupnou kinetickou energií, stejnou brzdnou sílu
při nepřijímajícím vedení, projekci brzdné dráhy proti skutečnému zastavení,
brzdové přechody, kolejovou brzdu, zhoršení adheze, zlepšení po pískování,
rozjezd výběhem z kopce, tlumený náklon v oblouku, hmotnostní a směrovou
odezvu střetu, rotační energii, jediný postih souvislého kontaktu,
doznívání otřesu i uložení. Nové kontroly pokrývají místní adhezi pod předním
a zadním vozem, plynulé zvlhnutí a vyschnutí, projekci přes úsek listí,
zlepšení po pískování, tepelnou bilanci a chlazení, mechanické doplnění
výkonově omezené elektrické brzdy, slábnutí při extrémní teplotě,
komfort a jediný postih souvislého přetížení i shodu velkých a malých kroků.

`node scripts/test-vehicle-collision.mjs` ověřuje propojení kontaktů scény
s fyzikou, boční hybnost, rotaci, skluz a zastavení auta bez návratu na
jízdní dráhu. `node scripts/test-vehicle-physics.mjs` kontroluje impulsy
obou aut, rotační odezvu, tření, hybnost a energetickou bilanci.
`node scripts/test-car-chain.mjs` ověřuje předávání nárazu mezi auty,
trvalé tlačení fronty tramvají, zaparkovaná a boční auta, kontakt bez
detailního vykreslení i stabilitu při velkých časových krocích.
`node scripts/test-traffic-spawn.mjs` hlídá bezpečné počáteční rozmístění
a parkování mimo jízdní koridor boční silnice.
`node scripts/test-traffic-clearance.mjs` hlídá odjezd aut
před přechodem, reakci na zvonek a zachování červené i bezpečnosti chodců.
`node scripts/test-audio.mjs` ověřuje sílu a jednorázové přehrání zvuku
nárazu pomocí náhrady Web Audio. Všechny tyto kontroly jsou součástí
`npm test`.

`node scripts/test-journey.mjs` prochází všech 44 zastávek Bílá Hora →
Nádraží Hostivař s třídou `Route`, skutečnou geometrií trasy, výškovým
profilem, oblouky a simulovanými cykly návěstidel. Testovací řidič existuje
pouze v testu a v dešti výslovně obsluhuje pískovač. Poslední ověření:
62,9 min na suchu, 71,5 min v dešti, maximum 48,5 km/h, spád až 7,56 %,
všech 44 zastávek bez projeté návěsti Stůj, překročení rychlosti nebo
nebezpečného otevření dveří. Největší odchylka zastavení byla 0,84 / 2,16 m.
Jde o výsledek simulace, nikoli skutečnou jízdní dobu linky 22.
