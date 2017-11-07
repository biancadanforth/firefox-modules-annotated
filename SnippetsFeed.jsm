// https://dxr.mozilla.org/mozilla-central/source/browser/extensions/activity-stream/lib/SnippetsFeed.jsm

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

// There is a C and Rust layer underneath JS,
// XPCOM (Cross-Platform Component Object Model) is a language for modularizing Firefox code
// There are different XPCOM interface for different things (e.g. nsIConsoleService, nsIDOMChromeWindow).
// XPConnect connects JS and XPCOM.
// There is an interconnect language that XPConnect uses, called IDL (a way to connect C/Rust interfaces to JavaScript; it is a common language)
// You can write XPCOM components in any language, not just C
// Components.utils.getWeakReference is useful, for example. E.g. say you have a mapping from a tab object to a number (like num times user visits Amazon)
// You have a reference to that tab somewhere in your code. So if user closes that tab, it cannot get garbage collected because you have a reference to it
// so you have to have a weak reference to it. If you have a weak map, garbage collector will still collect.
// Only downside is every time you use that item, you have to check that it exists. Weak Maps are now a thing in JS, so we don't need this method anymore
const {utils: Cu} = Components;

// If a bunch of modules import the same module 10x, it only gets loaded once
// On the other side, if you unload a module that is used elsewhere, it gets unloaded everywhere
// Reference count to this module is not tracked
// Cu.unload to unload the module
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
// Puts all exports from this module into the global scope
Cu.import("resource://gre/modules/Services.jsm");
// Actions.jsm exports way more than these two exports, this just imports a portion of the module
const {actionTypes: at, actionCreators: ac} = Cu.import("resource://activity-stream/common/Actions.jsm", {});

// CC : Components.classes, https://developer.mozilla.org/en-US/docs/Mozilla/Tech/XPCOM/Language_Bindings/Components.classes

// Load these modules whenever they are used; save start-up loading time
// first argument is which scope to load it in
// Without the 4th argument, it assumes the name you give as the second argument is the name
// of the actual exported symbol being obtained from this module
// including the 4th argument lets you add a custom symbol name to the official name you import
// as the second argument.
XPCOMUtils.defineLazyModuleGetter(this, "ShellService",
  "resource:///modules/ShellService.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "ProfileAge",
  "resource://gre/modules/ProfileAge.jsm");

// These are the names of actual Firefox prefs
// Url to fetch snippets, in the urlFormatter service format.
const SNIPPETS_URL_PREF = "browser.aboutHomeSnippets.updateUrl";
const TELEMETRY_PREF = "datareporting.healthreport.uploadEnabled";
const FXA_USERNAME_PREF = "services.sync.username";
const ONBOARDING_FINISHED_PREF = "browser.onboarding.notification.finished";
// Prefix for any target matching a search engine.
const TARGET_SEARCHENGINE_PREFIX = "searchEngine-";

const SEARCH_ENGINE_OBSERVER_TOPIC = "browser-search-engine-modified";

// Should be bumped up if the snippets content format changes.
const STARTPAGE_VERSION = 5;

const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;

this.SnippetsFeed = class SnippetsFeed {
  constructor() {
    this._refresh = this._refresh.bind(this);
  }

  get snippetsURL() {
    // Get a string (data type) pref, replace a placeholder value in that string and
    // return the updated string.
    const updateURL = Services
      .prefs.getStringPref(SNIPPETS_URL_PREF)
      .replace("%STARTPAGE_VERSION%", STARTPAGE_VERSION);
    // other information (like locale) is added to the URL
    // http[s]://%SERVICE%.mozilla.[com|org]/%LOCALE%/
    return Services.urlFormatter.formatURL(updateURL);
  }

  isDefaultBrowser() {
    try {
      // https://dxr.mozilla.org/mozilla-central/source/browser/components/shell/ShellService.jsm
      // mostly about checking the default browser by OS, etc.
      return ShellService.isDefaultBrowser();
    } catch (e) {}
    // istanbul ignore next
    return null;
  }

  async getProfileInfo() {
    // ProfileAge.jsm keeps track of profile age
    const profileAge = new ProfileAge(null, null);
    const createdDate = await profileAge.created;
    const resetDate = await profileAge.reset;
    return {
      // unit conversion into weeks
      createdWeeksAgo:  Math.floor((Date.now() - createdDate) / ONE_WEEK),
      resetWeeksAgo: resetDate ? Math.floor((Date.now() - resetDate) / ONE_WEEK) : null
    };
  }

  getSelectedSearchEngine() {
    return new Promise(resolve => {
      // Note: calling init ensures this code is only executed after Search has been initialized
      // Services can import an XPCOM component (which could be written in C or JavaScript); these components are like classes
      // Two methods on these classes
      Services.search.init(rv => {
        // istanbul ignore else
        // istanbul is a test tool; this comment above is an instruction.
        if (Components.isSuccessCode(rv)) {
          // Services.search maps to the nsIBrowserSearchService
          // You can have interfaces or classes, they are kind of fluid.
          // Interface Description Language: You can have a common language for describing interfaces that are independent of a language
          // This is the object, these are the properties/methods of it. It can be understood through other languages
          // Services.search gets an XPCOM componenent nsIBrowserSearchService
          // You need to also know which interface to use for a class (there is a topmost general class, nsISupports, likely you
          // want to be more specific)
          // Firefox keeps count of certain instances of certain classes, so it can garbage collect any that are not referenced. A way of dynamically
          // loading components.
          // https://developer.mozilla.org/en-US/docs/Mozilla/Tech/XPCOM/Reference/Interface/nsIBrowserSearchService
          // Services.jsm lazy loads services if they are references.
          // Services are XPCOM components (if you write C code for Firefox, you have access to these too)that are singletons (you don't instantiate them), whereas modules are JavaScript.
          let engines = Services.search.getVisibleEngines();
          resolve({
            searchEngineIdentifier: Services.search.defaultEngine.identifier,
            engines: engines
              .filter(engine => engine.identifier)
              .map(engine => `${TARGET_SEARCHENGINE_PREFIX}${engine.identifier}`)
          });
        } else {
          resolve({engines: [], searchEngineIdentifier: ""});
        }
      });
    });
  }

  _dispatchChanges(data) {
    // https://dxr.mozilla.org/mozilla-central/source/browser/extensions/activity-stream/lib/ActivityStream.jsm#260
    // this.store is an instance of the Store.jsm module that is made accessible to every feed, including SnippetsFeed in ActivityStream
    // search DXR for where SnippetsFeed is used and that's how we found it.
    this.store.dispatch(ac.BroadcastToContent({type: at.SNIPPETS_DATA, data}));
  }

  async _refresh() {
    const profileInfo = await this.getProfileInfo();
    const data = {
      profileCreatedWeeksAgo: profileInfo.createdWeeksAgo,
      profileResetWeeksAgo: profileInfo.resetWeeksAgo,
      snippetsURL: this.snippetsURL,
      version: STARTPAGE_VERSION,
      telemetryEnabled: Services.prefs.getBoolPref(TELEMETRY_PREF),
      onboardingFinished: Services.prefs.getBoolPref(ONBOARDING_FINISHED_PREF),
      fxaccount: Services.prefs.prefHasUserValue(FXA_USERNAME_PREF),
      selectedSearchEngine: await this.getSelectedSearchEngine(),
      defaultBrowser: this.isDefaultBrowser()
    };
    this._dispatchChanges(data);
  }

  async observe(subject, topic, data) {
    if (topic === SEARCH_ENGINE_OBSERVER_TOPIC) {
      const selectedSearchEngine = await this.getSelectedSearchEngine();
      this._dispatchChanges({selectedSearchEngine});
    }
  }

  async init() {
    await this._refresh();
    // When this pref changes, call this._refresh
    Services.prefs.addObserver(ONBOARDING_FINISHED_PREF, this._refresh);
    Services.prefs.addObserver(SNIPPETS_URL_PREF, this._refresh);
    Services.prefs.addObserver(TELEMETRY_PREF, this._refresh);
    Services.prefs.addObserver(FXA_USERNAME_PREF, this._refresh);
    // Observers are like a global event listener; accessible to any part of code that is listening.
    // https://developer.mozilla.org/en-US/docs/Observer_Notifications
    // calls SnippetsFeed.observe function when that an event with that topic happens
    // When user changes search engine, a message is sent to the global observer, this is propogated to all Firefox code that is listening to that change.
    Services.obs.addObserver(this, SEARCH_ENGINE_OBSERVER_TOPIC);
  }

  uninit() {
    Services.prefs.removeObserver(ONBOARDING_FINISHED_PREF, this._refresh);
    Services.prefs.removeObserver(SNIPPETS_URL_PREF, this._refresh);
    Services.prefs.removeObserver(TELEMETRY_PREF, this._refresh);
    Services.prefs.removeObserver(FXA_USERNAME_PREF, this._refresh);
    Services.obs.removeObserver(this, SEARCH_ENGINE_OBSERVER_TOPIC);
    this.store.dispatch(ac.BroadcastToContent({type: at.SNIPPETS_RESET}));
  }

  showFirefoxAccounts(browser) {
    // We want to replace the current tab.
    browser.loadURI("about:accounts?action=signup&entrypoint=snippets");
  }

  onAction(action) {
    switch (action.type) {
      case at.INIT:
        this.init();
        break;
      case at.UNINIT:
        this.uninit();
        break;
      case at.SHOW_FIREFOX_ACCOUNTS:
        this.showFirefoxAccounts(action._target.browser);
        break;
    }
  }
};

this.EXPORTED_SYMBOLS = ["SnippetsFeed"];