/*
Copyright 2016 OpenMarket Ltd

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
"use strict";
/**
 * @module models/event-timeline-set
 */

/**
 * Construct a set of EventTimeline objects, typically on behalf of a given
 * room.  A room may have multiple EventTimelineSets for different levels
 * of filtering.  The global notification list is also an EventTimelineSet, but
 * lacks a room.
 *
 * <p>This is an ordered sequence of timelines, which may or may not
 * be continuous. Each timeline lists a series of events, as well as tracking
 * the room state at the start and the end of the timeline (if appropriate).
 * It also tracks forward and backward pagination tokens, as well as containing
 * links to the
 * next timeline in the sequence.
 *
 * <p>There is one special timeline - the 'live' timeline, which represents the
 * timeline to which events are being added in real-time as they are received
 * from the /sync API. Note that you should not retain references to this
 * timeline - even if it is the current timeline right now, it may not remain
 * so if the server gives us a timeline gap in /sync.
 *
 * <p>In order that we can find events from their ids later, we also maintain a
 * map from event_id to timeline and index.
 */
function EventTimelineList(roomId, opts) {
    this._timelineSupport = Boolean(opts.timelineSupport);
    this._liveTimeline = new EventTimeline(this.roomId);
    this._fixUpLegacyTimelineFields();

    // just a list - *not* ordered.
    this._timelines = [this._liveTimeline];
    this._eventIdToTimeline = {};

    this._filter = opts.filter;
}
utils.inherits(EventTimelineList, EventEmitter);

/**
 * Get the filter object this timeline list is filtered on
 */
EventTimeline.prototype.getFilter = function() {
    return this._filter;
}

/**
 * Set the filter object this timeline list is filtered on
 * (passed to the server when paginating via /messages).
 */
EventTimeline.prototype.setFilter = function(filter) {
    this._filter = filter;
}

/**
 * Get the live timeline for this room.
 *
 * @return {module:models/event-timeline~EventTimeline} live timeline
 */
EventTimelineList.prototype.getLiveTimeline = function(filterId) {
    return this._liveTimeline;
};

/**
 * Reset the live timeline, and start a new one.
 *
 * <p>This is used when /sync returns a 'limited' timeline.
 *
 * @param {string=} backPaginationToken   token for back-paginating the new timeline
 *
 * @fires module:client~MatrixClient#event:"Room.timelineReset"
 */
EventTimelineList.prototype.resetLiveTimeline = function(backPaginationToken) {
    var newTimeline;

    if (!this._timelineSupport) {
        // if timeline support is disabled, forget about the old timelines
        newTimeline = new EventTimeline(this.roomId);
        this._timelines = [newTimeline];
        this._eventIdToTimeline = {};
    } else {
        newTimeline = this.addTimeline();
    }

    // initialise the state in the new timeline from our last known state
    var evMap = this._liveTimeline.getState(EventTimeline.FORWARDS).events;
    var events = [];
    for (var evtype in evMap) {
        if (!evMap.hasOwnProperty(evtype)) { continue; }
        for (var stateKey in evMap[evtype]) {
            if (!evMap[evtype].hasOwnProperty(stateKey)) { continue; }
            events.push(evMap[evtype][stateKey]);
        }
    }
    newTimeline.initialiseState(events);

    // make sure we set the pagination token before firing timelineReset,
    // otherwise clients which start back-paginating will fail, and then get
    // stuck without realising that they *can* back-paginate.
    newTimeline.setPaginationToken(backPaginationToken, EventTimeline.BACKWARDS);

    this._liveTimeline = newTimeline;
    this._fixUpLegacyTimelineFields();
    this.emit("Room.timelineReset", this);
};

/**
 * Fix up this.timeline, this.oldState and this.currentState
 *
 * @private
 */
EventTimelineList.prototype._fixUpLegacyTimelineFields = function() {
    // maintain this.timeline as a reference to the live timeline,
    // and this.oldState and this.currentState as references to the
    // state at the start and end of that timeline. These are more
    // for backwards-compatibility than anything else.
    this.timeline = this._liveTimeline.getEvents();
    this.oldState = this._liveTimeline.getState(EventTimeline.BACKWARDS);
    this.currentState = this._liveTimeline.getState(EventTimeline.FORWARDS);
};

/**
 * Get the timeline which contains the given event, if any
 *
 * @param {string} eventId  event ID to look for
 * @return {?module:models/event-timeline~EventTimeline} timeline containing
 * the given event, or null if unknown
 */
EventTimelineList.prototype.getTimelineForEvent = function(eventId) {
    var res = this._eventIdToTimeline[eventId];
    return (res === undefined) ? null : res;
};

/**
 * Get an event which is stored in our timelines
 *
 * @param {string} eventId  event ID to look for
 * @return {?module:models/event~MatrixEvent} the given event, or undefined if unknown
 */
EventTimelineList.prototype.findEventById = function(eventId) {
    var tl = this.getTimelineForEvent(eventId);
    if (!tl) {
        return undefined;
    }
    return utils.findElement(tl.getEvents(),
                             function(ev) { return ev.getId() == eventId; });
};

/**
 * Add a new timeline to this room
 *
 * @return {module:models/event-timeline~EventTimeline} newly-created timeline
 */
EventTimelineList.prototype.addTimeline = function() {
    if (!this._timelineSupport) {
        throw new Error("timeline support is disabled. Set the 'timelineSupport'" +
                        " parameter to true when creating MatrixClient to enable" +
                        " it.");
    }

    var timeline = new EventTimeline(this.roomId);
    this._timelines.push(timeline);
    return timeline;
};


/**
 * Add events to a timeline
 *
 * <p>Will fire "Room.timeline" for each event added.
 *
 * @param {MatrixEvent[]} events A list of events to add.
 *
 * @param {boolean} toStartOfTimeline   True to add these events to the start
 * (oldest) instead of the end (newest) of the timeline. If true, the oldest
 * event will be the <b>last</b> element of 'events'.
 *
 * @param {module:models/event-timeline~EventTimeline} timeline   timeline to
 *    add events to.
 *
 * @param {string=} paginationToken   token for the next batch of events
 *
 * @fires module:client~MatrixClient#event:"Room.timeline"
 *
 */
EventTimelineList.prototype.addEventsToTimeline = function(events, toStartOfTimeline,
                                              timeline, paginationToken) {
    if (!timeline) {
        throw new Error(
            "'timeline' not specified for EventTimelineList.addEventsToTimeline"
        );
    }

    if (!toStartOfTimeline && timeline == this._liveTimeline) {
        throw new Error(
            "Room.addEventsToTimeline cannot be used for adding events to " +
            "the live timeline - use EventTimelineList.addLiveEvents instead"
        );
    }

    var direction = toStartOfTimeline ? EventTimeline.BACKWARDS :
        EventTimeline.FORWARDS;
    var inverseDirection = toStartOfTimeline ? EventTimeline.FORWARDS :
        EventTimeline.BACKWARDS;

    // Adding events to timelines can be quite complicated. The following
    // illustrates some of the corner-cases.
    //
    // Let's say we start by knowing about four timelines. timeline3 and
    // timeline4 are neighbours:
    //
    //    timeline1    timeline2    timeline3    timeline4
    //      [M]          [P]          [S] <------> [T]
    //
    // Now we paginate timeline1, and get the following events from the server:
    // [M, N, P, R, S, T, U].
    //
    // 1. First, we ignore event M, since we already know about it.
    //
    // 2. Next, we append N to timeline 1.
    //
    // 3. Next, we don't add event P, since we already know about it,
    //    but we do link together the timelines. We now have:
    //
    //    timeline1    timeline2    timeline3    timeline4
    //      [M, N] <---> [P]          [S] <------> [T]
    //
    // 4. Now we add event R to timeline2:
    //
    //    timeline1    timeline2    timeline3    timeline4
    //      [M, N] <---> [P, R]       [S] <------> [T]
    //
    //    Note that we have switched the timeline we are working on from
    //    timeline1 to timeline2.
    //
    // 5. We ignore event S, but again join the timelines:
    //
    //    timeline1    timeline2    timeline3    timeline4
    //      [M, N] <---> [P, R] <---> [S] <------> [T]
    //
    // 6. We ignore event T, and the timelines are already joined, so there
    //    is nothing to do.
    //
    // 7. Finally, we add event U to timeline4:
    //
    //    timeline1    timeline2    timeline3    timeline4
    //      [M, N] <---> [P, R] <---> [S] <------> [T, U]
    //
    // The important thing to note in the above is what happened when we
    // already knew about a given event:
    //
    //   - if it was appropriate, we joined up the timelines (steps 3, 5).
    //   - in any case, we started adding further events to the timeline which
    //       contained the event we knew about (steps 3, 5, 6).
    //
    //
    // So much for adding events to the timeline. But what do we want to do
    // with the pagination token?
    //
    // In the case above, we will be given a pagination token which tells us how to
    // get events beyond 'U' - in this case, it makes sense to store this
    // against timeline4. But what if timeline4 already had 'U' and beyond? in
    // that case, our best bet is to throw away the pagination token we were
    // given and stick with whatever token timeline4 had previously. In short,
    // we want to only store the pagination token if the last event we receive
    // is one we didn't previously know about.
    //
    // We make an exception for this if it turns out that we already knew about
    // *all* of the events, and we weren't able to join up any timelines. When
    // that happens, it means our existing pagination token is faulty, since it
    // is only telling us what we already know. Rather than repeatedly
    // paginating with the same token, we might as well use the new pagination
    // token in the hope that we eventually work our way out of the mess.

    var didUpdate = false;
    var lastEventWasNew = false;
    for (var i = 0; i < events.length; i++) {
        var event = events[i];
        var eventId = event.getId();

        var existingTimeline = this._eventIdToTimeline[eventId];

        if (!existingTimeline) {
            // we don't know about this event yet. Just add it to the timeline.
            this.addEventToTimeline(event, timeline, toStartOfTimeline);
            lastEventWasNew = true;
            didUpdate = true;
            continue;
        }

        lastEventWasNew = false;

        if (existingTimeline == timeline) {
            debuglog("Event " + eventId + " already in timeline " + timeline);
            continue;
        }

        var neighbour = timeline.getNeighbouringTimeline(direction);
        if (neighbour) {
            // this timeline already has a neighbour in the relevant direction;
            // let's assume the timelines are already correctly linked up, and
            // skip over to it.
            //
            // there's probably some edge-case here where we end up with an
            // event which is in a timeline a way down the chain, and there is
            // a break in the chain somewhere. But I can't really imagine how
            // that would happen, so I'm going to ignore it for now.
            //
            if (existingTimeline == neighbour) {
                debuglog("Event " + eventId + " in neighbouring timeline - " +
                            "switching to " + existingTimeline);
            } else {
                debuglog("Event " + eventId + " already in a different " +
                            "timeline " + existingTimeline);
            }
            timeline = existingTimeline;
            continue;
        }

        // time to join the timelines.
        console.info("Already have timeline for " + eventId +
                     " - joining timeline " + timeline + " to " +
                     existingTimeline);
        timeline.setNeighbouringTimeline(existingTimeline, direction);
        existingTimeline.setNeighbouringTimeline(timeline, inverseDirection);
        timeline = existingTimeline;
        didUpdate = true;
    }

    // see above - if the last event was new to us, or if we didn't find any
    // new information, we update the pagination token for whatever
    // timeline we ended up on.
    if (lastEventWasNew || !didUpdate) {
        timeline.setPaginationToken(paginationToken, direction);
    }
};

/**
 * Add event to the live timeline
 */
EventTimelineList.prototype.addLiveEvent = function(event, duplicateStrategy) {
    if (this._filter) {
        var events = this._filter.filterRoomTimeline([event]);
        if (!events) return;
    }

    var timeline = this._eventIdToTimeline[event.getId()];
    if (timeline) {
        if (duplicateStrategy === "replace") {
            debuglog("EventTimelineList.addLiveEvent: replacing duplicate event " +
                     event.getId());
            var tlEvents = timeline.getEvents();
            for (var j = 0; j < tlEvents.length; j++) {
                if (tlEvents[j].getId() === event.getId()) {
                    // still need to set the right metadata on this event
                    this.setEventMetadata(
                        event,
                        timeline.getState(EventTimeline.FORWARDS),
                        false
                    );

                    if (!tlEvents[j].encryptedType) {
                        tlEvents[j] = event;
                    }

                    // XXX: we need to fire an event when this happens.
                    break;
                }
            }
        } else {
            debuglog("EventTimelineList.addLiveEvent: ignoring duplicate event " +
                     event.getId());
        }
        return;
    }

    this.addEventToTimeline(event, this._liveTimeline, false);
};

/**
 * Add event to the given timeline, and emit Room.timeline. Assumes
 * we have already checked we don't know about this event.
 *
 * Will fire "Room.timeline" for each event added.
 *
 * @param {MatrixEvent} event
 * @param {EventTimeline} timeline
 * @param {boolean} toStartOfTimeline
 *
 * @fires module:client~MatrixClient#event:"Room.timeline"
 *
 * @private
 */
EventTimelineList.prototype.addEventToTimeline = function(event, timeline, toStartOfTimeline) {
    var eventId = event.getId();
    timeline.addEvent(event, toStartOfTimeline);
    this._eventIdToTimeline[eventId] = timeline;

    var data = {
        timeline: timeline,
        liveEvent: !toStartOfTimeline && timeline == this._liveTimeline,
        filter: this._filter,
    };
    this.emit("Room.timeline", event, this, Boolean(toStartOfTimeline), false, data);
};

/**
 * Helper method to set sender and target properties, private to Room and EventTimelineList
 */
EventTimelineList.prototype.setEventMetadata = function(event, stateContext, toStartOfTimeline) {
    event.sender = stateContext.getSentinelMember(
        event.getSender()
    );
    if (event.getType() === "m.room.member") {
        event.target = stateContext.getSentinelMember(
            event.getStateKey()
        );
    }
    if (event.isState()) {
        // room state has no concept of 'old' or 'current', but we want the
        // room state to regress back to previous values if toStartOfTimeline
        // is set, which means inspecting prev_content if it exists. This
        // is done by toggling the forwardLooking flag.
        if (toStartOfTimeline) {
            event.forwardLooking = false;
        }
    }
}

/**
 * Removes a single event from this room.
 *
 * @param {String} eventId  The id of the event to remove
 *
 * @return {?MatrixEvent} the removed event, or null if the event was not found
 * in this room.
 */
EventTimelineList.prototype.removeEvent = function(eventId) {
    var timeline = this._eventIdToTimeline[eventId];
    if (!timeline) {
        return null;
    }

    var removed = timeline.removeEvent(eventId);
    if (removed) {
        delete this._eventIdToTimeline[eventId];
        var data = {
            timeline: timeline,
        };
        this.emit("Room.timeline", removed, this, undefined, true, data);
    }
    return removed;
};

/**
 * Determine where two events appear in the timeline relative to one another
 *
 * @param {string} eventId1   The id of the first event
 * @param {string} eventId2   The id of the second event

 * @return {?number} a number less than zero if eventId1 precedes eventId2, and
 *    greater than zero if eventId1 succeeds eventId2. zero if they are the
 *    same event; null if we can't tell (either because we don't know about one
 *    of the events, or because they are in separate timelines which don't join
 *    up).
 */
EventTimelineList.prototype.compareEventOrdering = function(eventId1, eventId2) {
    if (eventId1 == eventId2) {
        // optimise this case
        return 0;
    }

    var timeline1 = this._eventIdToTimeline[eventId1];
    var timeline2 = this._eventIdToTimeline[eventId2];

    if (timeline1 === undefined) {
        return null;
    }
    if (timeline2 === undefined) {
        return null;
    }

    if (timeline1 === timeline2) {
        // both events are in the same timeline - figure out their
        // relative indices
        var idx1, idx2;
        var events = timeline1.getEvents();
        for (var idx = 0; idx < events.length &&
             (idx1 === undefined || idx2 === undefined); idx++) {
            var evId = events[idx].getId();
            if (evId == eventId1) {
                idx1 = idx;
            }
            if (evId == eventId2) {
                idx2 = idx;
            }
        }
        return idx1 - idx2;
    }

    // the events are in different timelines. Iterate through the
    // linkedlist to see which comes first.

    // first work forwards from timeline1
    var tl = timeline1;
    while (tl) {
        if (tl === timeline2) {
            // timeline1 is before timeline2
            return -1;
        }
        tl = tl.getNeighbouringTimeline(EventTimeline.FORWARDS);
    }

    // now try backwards from timeline1
    tl = timeline1;
    while (tl) {
        if (tl === timeline2) {
            // timeline2 is before timeline1
            return 1;
        }
        tl = tl.getNeighbouringTimeline(EventTimeline.BACKWARDS);
    }

    // the timelines are not contiguous.
    return null;
};