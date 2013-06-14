"use strict";
/*global setImmediate: true*/

var base = require("node-base"),
	C = require("C"),
	cheerio = require("cheerio"),
	request = require("request"),
	fs = require("fs"),
	url = require("url"),
	moment = require("moment"),
	path = require("path"),
	querystring = require("querystring"),
	tiptoe = require("tiptoe");

function ripSet(setName, cb)
{
	tiptoe(
		function getListHTML()
		{
			var listURL = url.format(
			{
				protocol : "http",
				host     : "gatherer.wizards.com",
				pathname : "/Pages/Search/Default.aspx",
				query    :
				{
					output : "checklist",
					sort   : "cn+",
					set    : "[" + JSON.stringify(setName) + "]"
				}
			});

			request(listURL, this);
		},
		function processFirstBatch(response, listHTML)
		{
			var listDoc = cheerio.load(listHTML);

			this.data.set = base.clone(C.SETS.mutateOnce(function(SET) { return SET.name===setName ? SET : undefined; }));

			processMultiverseids(listDoc("table.checklist tr.cardItem a.nameLink").map(function(i, itemRaw) { return +querystring.parse(url.parse(listDoc(itemRaw).attr("href")).query).multiverseid; }).unique(), this);
		},
		function processVariations(cards)
		{
			this.data.set.cards = cards;
			processMultiverseids(cards.map(function(card) { return (card.variations && card.variations.length) ? card.variations : []; }).flatten().unique().subtract(cards.map(function(card) { return card.multiverseid; })), this);
		},
		function finish(err, cards)
		{
			if(err)
				return setImmediate(function() { cb(err); });

			this.data.set.cards = this.data.set.cards.concat(cards);

			setImmediate(function() { cb(err, this.data.set); }.bind(this));
		}
	);
}
exports.ripSet = ripSet;

function processMultiverseids(multiverseids, cb)
{
	var cards = [];

	multiverseids.unique().serialForEach(function(multiverseid, subcb)
	{
		tiptoe(
			function getMultiverseDoc()
			{
				getDoc(multiverseid, this);
			},
			function finish(err, multiverseDoc)
			{
				if(err || !multiverseDoc)
					return setImmediate(function() { subcb(err || new Error("Invalid multiverse response")); });

				getCardParts(multiverseDoc).forEach(function(cardPart) { cards.push(processCardPart(multiverseDoc, cardPart)); });

				setImmediate(subcb);
			}
		);
	}, function(err) { return cb(err, cards); });
}

var SYMBOL_CONVERSION_MAP =
{
	"white"              : "W",
	"black"              : "B",
	"red"                : "R",
	"blue"               : "U",
	"green"              : "G",
	"zero"               : "0",
	"one"                : "1",
	"two"                : "2",
	"three"              : "3",
	"four"               : "4",
	"five"               : "5",
	"six"                : "6",
	"seven"              : "7",
	"eight"              : "8",
	"nine"               : "9",
	"ten"                : "10",
	"eleven"             : "11",
	"twelve"             : "12",
	"thirteen"           : "13",
	"fourteen"           : "14",
	"fifteen"            : "15",
	"sixteen"            : "16",
	"0"                  : "0",
	"1"                  : "1",
	"2"                  : "2",
	"3"                  : "3",
	"4"                  : "4",
	"5"                  : "5",
	"6"                  : "6",
	"7"                  : "7",
	"8"                  : "8",
	"9"                  : "9",
	"10"                 : "10",
	"11"                 : "11",
	"12"                 : "12",
	"13"                 : "13",
	"14"                 : "14",
	"15"                 : "15",
	"16"                 : "16",
	"tap"                : "T",
	"untap"              : "Q",
	"snow"               : "S",
	"phyrexian white"    : "PW",
	"phyrexian black"    : "PB",
	"phyrexian red"      : "PR",
	"phyrexian blue"     : "PU",
	"phyrexian green"    : "PG",
	"variable colorless" : "X"
};

function processSymbol(symbol)
{
	var symbols = symbol.toLowerCase().split(" or ").map(function(symbolPart)
	{
		symbolPart = symbolPart.trim();
		if(!SYMBOL_CONVERSION_MAP.hasOwnProperty(symbolPart))
		{
			base.warn("Invalid symbolPart [%s] with full value: %s", symbolPart, symbol);
			return "UNKNOWN";
		}

		return SYMBOL_CONVERSION_MAP[symbolPart];
	});

	return "{" + (symbols.length>1 ? symbols.join("/") : symbols[0]) + "}";
}

function processCardPart(doc, cardPart)
{
	var card =
	{
		supertypes : [],
		type       : "",
		types      : []
	};

	var idPrefix = "#" + cardPart.find(".rightCol").attr("id").replaceAll("_rightCol", "");

	// Multiverseid
	card.multiverseid = +querystring.parse(url.parse(doc("#aspnetForm").attr("action")).query).multiverseid.trim();

	// Card Name
	card.name = cardPart.find(idPrefix + "_nameRow .value").text().trim();

	// Card Type
	var rawTypes = cardPart.find(idPrefix + "_typeRow .value").text().trim().split("—");
	rawTypes[0].split(" ").filterEmpty().forEach(function(rawType, i)
	{
		card.type += (i>0 ? " " : "") + rawType;

		rawType = rawType.trim().toProperCase();
		if(C.SUPERTYPES.contains(rawType))
			card.supertypes.push(rawType);
		else if(C.TYPES.contains(rawType))
			card.types.push(rawType);
		else
			base.warn("Raw type not found: %s", rawType);
	});
	if(rawTypes.length>1)
	{
		card.subtypes = card.types.contains("Plane") ? [rawTypes[1].trim()] : rawTypes[1].split(" ").filterEmpty().map(function(subtype) { return subtype.trim(); });	// 205.3b Planes have just a single subtype
		card.type += " - " + card.subtypes.join(" ");
	}
	if(!card.supertypes.length)
		delete card.supertypes;
	if(!card.types.length)
		delete card.types;

	// Converted Mana Cost (CMC)
	var cardCMC = cardPart.find(idPrefix + "_cmcRow .value").text().trim();
	if(cardCMC)
		card.cmc = +cardCMC;

	// Rarity
	card.rarity = cardPart.find(idPrefix + "_rarityRow .value").text().trim();

	// Artist
	card.artist = cardPart.find(idPrefix + "_artistRow .value a").text().trim();

	// Power/Toughness or Loyalty
	var powerToughnessValue = cardPart.find(idPrefix + "_ptRow .value").text().trim();
	if(powerToughnessValue)
	{
		// Loyalty
		if(card.types.contains("Planeswalker"))
		{
			card.loyalty = +powerToughnessValue.trim();
		}
		else
		{
			// Power/Toughness
			var powerToughnessParts = powerToughnessValue.split("/");
			if(powerToughnessParts.length!==2)
			{
				base.warn("Power toughness invalid: %s", powerToughnessValue);
			}
			else
			{
				card.power = +powerToughnessParts[0].trim();
				card.toughness = +powerToughnessParts[1].trim();
			}
		}
	}

	// Mana Cost
	var cardManaCost = cardPart.find(idPrefix + "_manaRow .value img").map(function(i, item) { return doc(item); }).map(function(manaCost) { return processSymbol(manaCost.attr("alt")); }).join("");
	if(cardManaCost)
		card.manaCost = cardManaCost;

	// Text
	var cardText = processTextBlocks(doc, cardPart.find(idPrefix + "_textRow .value .cardtextbox")).trim();
	if(cardText)
		card.text = cardText;

	// Flavor Text
	var cardFlavor = processTextBlocks(doc, cardPart.find(idPrefix + "_flavorRow .value .cardtextbox")).trim();
	if(cardFlavor)
		card.flavor = cardFlavor;

	// Card Number
	var cardNumberValue = cardPart.find(idPrefix + "_numberRow .value").text().trim();
	if(cardNumberValue)
		card.number = +cardNumberValue;

	// Rulings
	var rulingRows = cardPart.find(idPrefix + "_rulingsContainer table tr.post");
	if(rulingRows.length)
		card.rulings = rulingRows.map(function(i, item) { return doc(item); }).map(function(rulingRow) { return { date : moment(rulingRow.find("td:first-child").text().trim(), "MM/DD/YYYY").format("YYYY-MM-DD"), text : rulingRow.find("td:last-child").text().trim()}; });

	// Variations
	var variationLinks = cardPart.find(idPrefix + "_variationLinks a.variationLink").map(function(i, item) { return doc(item); });
	if(variationLinks.length)
		card.variations = variationLinks.map(function(variationLink) { return +variationLink.attr("id").trim(); }).filter(function(variation) { return variation!==card.multiverseid; });

	return card;
}

function processTextBlocks(doc, textBlocks)
{
	var result = "";

	textBlocks.map(function(i, item) { return doc(item); }).forEach(function(textBox, i)
	{
		if(i>0)
			result += "\n\n";

		textBox.toArray().forEach(function(child)
		{
			result += processTextBoxChildren(doc, child.children);
		});
	});

	return result;
}

function processTextBoxChildren(doc, children)
{
	var result = "";

	children.forEach(function(child)
	{
		if(child.type==="tag")
		{
			if(child.name==="img")
				result += processSymbol(doc(child).attr("alt"));
			else if(child.name==="i")
			{
				result += processTextBoxChildren(doc, child.children);
			}
			else
				base.warn("Unsupported text child tag name: %s", child.name);
		}
		else if(child.type==="text")
		{
			result += child.data;
		}
		else
		{
			base.warn("Unknown text child type: %s", child.type);
		}
	});

	return result;
}

function getCardParts(doc)
{
	return doc("table.cardDetails").map(function(i, item) { return doc(item); });
}

function getDoc(multiverseid, cb)
{
	tiptoe(
		function getHTML()
		{
			var pageURL = url.format(
			{
				protocol : "http",
				host     : "gatherer.wizards.com",
				pathname : "/Pages/Card/Details.aspx",
				query    :
				{
					multiverseid : multiverseid,
					printed      : "false"
				}
			});

			if(fs.existsSync(path.join("/", "tmp", multiverseid + ".html")))
				fs.readFile(path.join("/", "tmp", multiverseid + ".html"), {encoding:"utf8"}, function(err, data) { this(null, null, data); }.bind(this));
			else
				request(pageURL, this);
		},
		function createDoc(err, response, pageHTML)
		{
			if(err)
				return setImmediate(function() { cb(err); });

			if(!fs.existsSync(path.join("/", "tmp", multiverseid + ".html")))
				fs.writeFileSync(path.join("/", "tmp", multiverseid + ".html"), pageHTML, {encoding:"utf8"});

			setImmediate(function() { cb(null, cheerio.load(pageHTML)); }.bind(this));
		}
	);
}

exports.tmp = function(cb)
{
	tiptoe(
		function step1()
		{
			getDoc(process.argv[2], this);
		},
		function step2(doc)
		{
			var cardParts = getCardParts(doc);
			cardParts.forEach(function(cardPart) { base.info(processCardPart(doc, cardPart)); });
			this();
		},
		function finish(err)
		{
			setImmediate(function() { cb(err); });
		}
	);
};
