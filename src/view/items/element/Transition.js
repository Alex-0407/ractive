import { win } from '../../../config/environment';
import { addToArray, removeFromArray } from '../../../utils/array';
import { objectKeys } from '../../../utils/object';
import { isArray, isFunction, isNumber, isString } from '../../../utils/is';
import findElement from '../shared/findElement';
import prefix from './transitions/prefix';
import { warnOnceIfDebug } from '../../../utils/log';
import { missingPlugin } from '../../../config/errors';
import { findInViewHierarchy } from '../../../shared/registry';
import { visible } from '../../../config/visibility';
import createTransitions from './transitions/createTransitions';
import resetStyle from './transitions/resetStyle';
import { resolveArgs, setupArgsFn } from '../shared/directiveArgs';
import noop from '../../../utils/noop';

const getComputedStyle = win && win.getComputedStyle;
const resolved = Promise.resolve();

const names = {
	t0: 'intro-outro',
	t1: 'intro',
	t2: 'outro'
};

export default class Transition {
	constructor ( options ) {
		this.owner = options.owner || options.parentFragment.owner || findElement( options.parentFragment );
		this.element = this.owner.attributeByName ? this.owner : findElement( options.parentFragment );
		this.ractive = this.owner.ractive;
		this.template = options.template;
		this.parentFragment = options.parentFragment;
		this.options = options;
		this.onComplete = [];
	}

	animateStyle ( style, value, options ) {
		if ( arguments.length === 4 ) {
			throw new Error( 't.animateStyle() returns a promise - use .then() instead of passing a callback' );
		}

		// Special case - page isn't visible. Don't animate anything, because
		// that way you'll never get CSS transitionend events
		if ( !visible ) {
			this.setStyle( style, value );
			return resolved;
		}

		let to;

		if ( isString( style ) ) {
			to = {};
			to[ style ] = value;
		} else {
			to = style;

			// shuffle arguments
			options = value;
		}

		// As of 0.3.9, transition authors should supply an `option` object with
		// `duration` and `easing` properties (and optional `delay`), plus a
		// callback function that gets called after the animation completes

		// TODO remove this check in a future version
		if ( !options ) {
			warnOnceIfDebug( 'The "%s" transition does not supply an options object to `t.animateStyle()`. This will break in a future version of Ractive. For more info see https://github.com/RactiveJS/Ractive/issues/340', this.name );
			options = this;
		}

		return new Promise( fulfil => {
			// Edge case - if duration is zero, set style synchronously and complete
			if ( !options.duration ) {
				this.setStyle( to );
				fulfil();
				return;
			}

			// Get a list of the properties we're animating
			const propertyNames = objectKeys( to );
			const changedProperties = [];

			// Store the current styles
			const computedStyle = getComputedStyle( this.node );

			let i = propertyNames.length;
			while ( i-- ) {
				const prop = propertyNames[i];
				let current = computedStyle[ prefix( prop ) ];

				if ( current === '0px' ) current = 0;

				// we need to know if we're actually changing anything
				if ( current != to[ prop ] ) { // use != instead of !==, so we can compare strings with numbers
					changedProperties.push( prop );

					// make the computed style explicit, so we can animate where
					// e.g. height='auto'
					this.node.style[ prefix( prop ) ] = current;
				}
			}

			// If we're not actually changing anything, the transitionend event
			// will never fire! So we complete early
			if ( !changedProperties.length ) {
				fulfil();
				return;
			}

			createTransitions( this, to, options, changedProperties, fulfil );
		});
	}

	bind () {
		const options = this.options;
		const type = options.template && options.template.v;
		if ( type ) {
			if ( type === 't0' || type === 't1' ) this.element.intro = this;
			if ( type === 't0' || type === 't2' ) this.element.outro = this;
			this.eventName = names[ type ];
		}

		const ractive = this.owner.ractive;

		this.name = options.name || options.template.n;

		if ( options.params ) {
			this.params = options.params;
		}

		if ( isFunction( this.name ) ) {
			this._fn = this.name;
			this.name = this._fn.name;
		} else {
			this._fn = findInViewHierarchy( 'transitions', ractive, this.name );
		}

		if ( !this._fn ) {
			warnOnceIfDebug( missingPlugin( this.name, 'transition' ), { ractive });
		}

		setupArgsFn( this, options.template );
	}

	getParams () {
		if ( this.params ) return this.params;

		// get expression args if supplied
		if ( this.fn ) {
			const values = resolveArgs( this, this.template, this.parentFragment ).map( model => {
				if ( !model ) return undefined;

				return model.get();
			});
			return this.fn.apply( this.ractive, values );
		}
	}

	getStyle ( props ) {
		const computedStyle = getComputedStyle( this.node );

		if ( isString( props ) ) {
			const value = computedStyle[ prefix( props ) ];
			return value === '0px' ? 0 : value;
		}

		if ( !isArray( props ) ) {
			throw new Error( 'Transition$getStyle must be passed a string, or an array of strings representing CSS properties' );
		}

		const styles = {};

		let i = props.length;
		while ( i-- ) {
			const prop = props[i];
			let value = computedStyle[ prefix( prop ) ];

			if ( value === '0px' ) value = 0;
			styles[ prop ] = value;
		}

		return styles;
	}

	processParams ( params, defaults ) {
		if ( isNumber ( params ) ) {
			params = { duration: params };
		}

		else if ( isString( params ) ) {
			if ( params === 'slow' ) {
				params = { duration: 600 };
			} else if ( params === 'fast' ) {
				params = { duration: 200 };
			} else {
				params = { duration: 400 };
			}
		} else if ( !params ) {
			params = {};
		}

		return Object.assign( {}, defaults, params );
	}

	registerCompleteHandler ( fn ) {
		addToArray( this.onComplete, fn );
	}

	setStyle ( style, value ) {
		if ( isString( style ) ) {
			this.node.style[ prefix( style ) ] = value;
		}

		else {
			let prop;
			for ( prop in style ) {
				if ( style.hasOwnProperty( prop ) ) {
					this.node.style[ prefix( prop ) ] = style[ prop ];
				}
			}
		}

		return this;
	}

	shouldFire ( type ) {
		if ( !this.ractive.transitionsEnabled ) return false;

		// check for noIntro and noOutro cases, which only apply when the owner ractive is rendering and unrendering, respectively
		if ( type === 'intro' && this.ractive.rendering && nearestProp( 'noIntro', this.ractive, true ) ) return false;
		if ( type === 'outro' && this.ractive.unrendering && nearestProp( 'noOutro', this.ractive, false ) ) return false;

		const params = this.getParams(); // this is an array, the params object should be the first member
		// if there's not a parent element, this can't be nested, so roll on
		if ( !this.element.parent ) return true;

		// if there is a local param, it takes precedent
		if ( params && params[0] && 'nested' in params[0] ) {
			if ( params[0].nested !== false ) return true;
		} else { // use the nearest instance setting
			// find the nearest instance that actually has a nested setting
			if ( nearestProp( 'nestedTransitions', this.ractive ) !== false ) return true;
		}

		// check to see if this is actually a nested transition
		let el = this.element.parent;
		while ( el ) {
			if ( el[type] && el[type].starting ) return false;
			el = el.parent;
		}

		return true;
	}

	start () {
		const node = this.node = this.element.node;
		const originalStyle = node.getAttribute( 'style' );

		let completed;
		const args = this.getParams();

		// create t.complete() - we don't want this on the prototype,
		// because we don't want `this` silliness when passing it as
		// an argument
		this.complete = noReset => {
			this.starting = false;
			if ( completed ) {
				return;
			}

			this.onComplete.forEach( fn => fn() );
			if ( !noReset && this.isIntro ) {
				resetStyle( node, originalStyle);
			}

			this._manager.remove( this );

			completed = true;
		};

		// If the transition function doesn't exist, abort
		if ( !this._fn ) {
			this.complete();
			return;
		}

		const promise = this._fn.apply( this.ractive, [ this ].concat( args ) );
		if ( promise ) promise.then( this.complete );
	}

	toString () { return ''; }

	unbind () {
		if ( !this.element.attributes.unbinding ) {
			const type = this.options && this.options.template && this.options.template.v;
			if ( type === 't0' || type === 't1' ) this.element.intro = null;
			if ( type === 't0' || type === 't2' ) this.element.outro = null;
		}
	}

	unregisterCompleteHandler ( fn ) {
		removeFromArray( this.onComplete, fn );
	}
}

const proto = Transition.prototype;
proto.destroyed = proto.render = proto.unrender = proto.update = noop;

function nearestProp ( prop, ractive, rendering ) {
	let instance = ractive;
	while ( instance ) {
		if ( instance.hasOwnProperty( prop ) && ( rendering === undefined || rendering ? instance.rendering : instance.unrendering ) ) return instance[ prop ];
		instance = instance.component && instance.component.ractive;
	}

	return ractive[ prop ];
}
