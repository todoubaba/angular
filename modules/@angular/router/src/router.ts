import {OnInit, provide, ReflectiveInjector, ComponentResolver} from '@angular/core';
import {RouterOutlet} from './directives/router_outlet';
import {Type, isBlank, isPresent} from './facade/lang';
import {ListWrapper} from './facade/collection';
import {EventEmitter, Observable, PromiseWrapper, ObservableWrapper} from './facade/async';
import {StringMapWrapper} from './facade/collection';
import {BaseException} from '@angular/core';
import {RouterUrlSerializer} from './router_url_serializer';
import {CanDeactivate} from './interfaces';
import {recognize} from './recognize';
import {Location} from '@angular/common';
import {link} from './link';

import {
  equalSegments,
  routeSegmentComponentFactory,
  RouteSegment,
  UrlTree,
  RouteTree,
  rootNode,
  TreeNode,
  UrlSegment,
  serializeRouteSegmentTree
} from './segments';
import {hasLifecycleHook} from './lifecycle_reflector';
import {DEFAULT_OUTLET_NAME} from './constants';

/**
 * @internal
 */
export class RouterOutletMap {
  /** @internal */
  _outlets: {[name: string]: RouterOutlet} = {};
  registerOutlet(name: string, outlet: RouterOutlet): void { this._outlets[name] = outlet; }
}

/**
 * The `Router` is responsible for mapping URLs to components.
 *
 * You can see the state of the router by inspecting the read-only fields `router.urlTree`
 * and `router.routeTree`.
 */
export class Router {
  private _prevTree: RouteTree;
  private _urlTree: UrlTree;
  private _locationSubscription: any;
  private _changes: EventEmitter<void> = new EventEmitter<void>();

  /**
   * @internal
   */
  constructor(private _rootComponent: Object, private _rootComponentType: Type,
              private _componentResolver: ComponentResolver,
              private _urlSerializer: RouterUrlSerializer,
              private _routerOutletMap: RouterOutletMap, private _location: Location) {
    this._prevTree = this._createInitialTree();
    this._setUpLocationChangeListener();
    this.navigateByUrl(this._location.path());
  }

  /**
   * Returns the current url tree.
   */
  get urlTree(): UrlTree { return this._urlTree; }

  /**
   * Returns the current route tree.
   */
  get routeTree(): RouteTree { return this._prevTree; }

  /**
   * An observable or url changes from the router.
   */
  get changes(): Observable<void> { return this._changes; }

  /**
   * Navigate based on the provided url. This navigation is always absolute.
   *
   * ### Usage
   *
   * ```
   * router.navigateByUrl("/team/33/user/11");
   * ```
   */
  navigateByUrl(url: string): Promise<void> {
    return this._navigate(this._urlSerializer.parse(url));
  }

  /**
   * Navigate based on the provided array of commands and a starting point.
   * If no segment is provided, the navigation is absolute.
   *
   * ### Usage
   *
   * ```
   * router.navigate(['team', 33, 'team', '11], segment);
   * ```
   */
  navigate(commands: any[], segment?: RouteSegment): Promise<void> {
    return this._navigate(this.createUrlTree(commands, segment));
  }

  /**
   * @internal
   */
  dispose(): void { ObservableWrapper.dispose(this._locationSubscription); }

  /**
   * Applies an array of commands to the current url tree and creates
   * a new url tree.
   *
   * When given a segment, applies the given commands starting from the segment.
   * When not given a segment, applies the given command starting from the root.
   *
   * ### Usage
   *
   * ```
   * // create /team/33/user/11
   * router.createUrlTree(['/team', 33, 'user', 11]);
   *
   * // create /team/33;expand=true/user/11
   * router.createUrlTree(['/team', 33, {expand: true}, 'user', 11]);
   *
   * // you can collapse static fragments like this
   * router.createUrlTree(['/team/33/user', userId]);
   *
   * // assuming the current url is `/team/33/user/11` and the segment points to `user/11`
   *
   * // navigate to /team/33/user/11/details
   * router.createUrlTree(['details'], segment);
   *
   * // navigate to /team/33/user/22
   * router.createUrlTree(['../22'], segment);
   *
   * // navigate to /team/44/user/22
   * router.createUrlTree(['../../team/44/user/22'], segment);
   * ```
   */
  createUrlTree(commands: any[], segment?: RouteSegment): UrlTree {
    let s = isPresent(segment) ? segment : this._prevTree.root;
    return link(s, this._prevTree, this.urlTree, commands);
  }

  /**
   * Serializes a {@link UrlTree} into a string.
   */
  serializeUrl(url: UrlTree): string { return this._urlSerializer.serialize(url); }

  private _createInitialTree(): RouteTree {
    let root = new RouteSegment([new UrlSegment("", {}, null)], {}, DEFAULT_OUTLET_NAME,
                                this._rootComponentType, null);
    return new RouteTree(new TreeNode<RouteSegment>(root, []));
  }

  private _setUpLocationChangeListener(): void {
    this._locationSubscription = this._location.subscribe(
        (change) => { this._navigate(this._urlSerializer.parse(change['url'])); });
  }

  private _navigate(url: UrlTree): Promise<void> {
    this._urlTree = url;
    return recognize(this._componentResolver, this._rootComponentType, url)
        .then(currTree => {
          return new _LoadSegments(currTree, this._prevTree)
              .load(this._routerOutletMap, this._rootComponent)
              .then(updated => {
                if (updated) {
                  this._prevTree = currTree;
                  this._location.go(this._urlSerializer.serialize(this._urlTree));
                  this._changes.emit(null);
                }
              });
        });
  }
}


class _LoadSegments {
  private deactivations: Object[][] = [];
  private performMutation: boolean = true;

  constructor(private currTree: RouteTree, private prevTree: RouteTree) {}

  load(parentOutletMap: RouterOutletMap, rootComponent: Object): Promise<boolean> {
    let prevRoot = isPresent(this.prevTree) ? rootNode(this.prevTree) : null;
    let currRoot = rootNode(this.currTree);

    return this.canDeactivate(currRoot, prevRoot, parentOutletMap, rootComponent)
        .then(res => {
          this.performMutation = true;
          if (res) {
            this.loadChildSegments(currRoot, prevRoot, parentOutletMap, [rootComponent]);
          }
          return res;
        });
  }

  private canDeactivate(currRoot: TreeNode<RouteSegment>, prevRoot: TreeNode<RouteSegment>,
                        outletMap: RouterOutletMap, rootComponent: Object): Promise<boolean> {
    this.performMutation = false;
    this.loadChildSegments(currRoot, prevRoot, outletMap, [rootComponent]);

    let allPaths = PromiseWrapper.all(this.deactivations.map(r => this.checkCanDeactivatePath(r)));
    return allPaths.then((values: boolean[]) => values.filter(v => v).length === values.length);
  }

  private checkCanDeactivatePath(path: Object[]): Promise<boolean> {
    let curr = PromiseWrapper.resolve(true);
    for (let p of ListWrapper.reversed(path)) {
      curr = curr.then(_ => {
        if (hasLifecycleHook("routerCanDeactivate", p)) {
          return (<CanDeactivate>p).routerCanDeactivate(this.prevTree, this.currTree);
        } else {
          return _;
        }
      });
    }
    return curr;
  }

  private loadChildSegments(currNode: TreeNode<RouteSegment>, prevNode: TreeNode<RouteSegment>,
                            outletMap: RouterOutletMap, components: Object[]): void {
    let prevChildren = isPresent(prevNode) ?
                           prevNode.children.reduce(
                               (m, c) => {
                                 m[c.value.outlet] = c;
                                 return m;
                               },
                               {}) :
                           {};

    currNode.children.forEach(c => {
      this.loadSegments(c, prevChildren[c.value.outlet], outletMap, components);
      StringMapWrapper.delete(prevChildren, c.value.outlet);
    });

    StringMapWrapper.forEach(prevChildren,
                             (v, k) => this.unloadOutlet(outletMap._outlets[k], components));
  }

  loadSegments(currNode: TreeNode<RouteSegment>, prevNode: TreeNode<RouteSegment>,
               parentOutletMap: RouterOutletMap, components: Object[]): void {
    let curr = currNode.value;
    let prev = isPresent(prevNode) ? prevNode.value : null;
    let outlet = this.getOutlet(parentOutletMap, currNode.value);

    if (equalSegments(curr, prev)) {
      this.loadChildSegments(currNode, prevNode, outlet.outletMap,
                             components.concat([outlet.loadedComponent]));
    } else {
      this.unloadOutlet(outlet, components);
      if (this.performMutation) {
        let outletMap = new RouterOutletMap();
        let loadedComponent = this.loadNewSegment(outletMap, curr, prev, outlet);
        this.loadChildSegments(currNode, prevNode, outletMap, components.concat([loadedComponent]));
      }
    }
  }

  private loadNewSegment(outletMap: RouterOutletMap, curr: RouteSegment, prev: RouteSegment,
                         outlet: RouterOutlet): Object {
    let resolved = ReflectiveInjector.resolve(
        [provide(RouterOutletMap, {useValue: outletMap}), provide(RouteSegment, {useValue: curr})]);
    let ref = outlet.load(routeSegmentComponentFactory(curr), resolved, outletMap);
    if (hasLifecycleHook("routerOnActivate", ref.instance)) {
      ref.instance.routerOnActivate(curr, prev, this.currTree, this.prevTree);
    }
    return ref.instance;
  }

  private getOutlet(outletMap: RouterOutletMap, segment: RouteSegment): RouterOutlet {
    let outlet = outletMap._outlets[segment.outlet];
    if (isBlank(outlet)) {
      if (segment.outlet == DEFAULT_OUTLET_NAME) {
        throw new BaseException(`Cannot find default outlet`);
      } else {
        throw new BaseException(`Cannot find the outlet ${segment.outlet}`);
      }
    }
    return outlet;
  }

  private unloadOutlet(outlet: RouterOutlet, components: Object[]): void {
    if (isPresent(outlet) && outlet.isLoaded) {
      StringMapWrapper.forEach(outlet.outletMap._outlets,
                               (v, k) => this.unloadOutlet(v, components));
      if (this.performMutation) {
        outlet.unload();
      } else {
        this.deactivations.push(components.concat([outlet.loadedComponent]));
      }
    }
  }
}
